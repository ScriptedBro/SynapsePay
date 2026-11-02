import crypto from 'node:crypto';
import vm from 'node:vm';
import { DeterministicCheckSpec, DeliverableArtifact } from '../types/contract.js';
import { CheckResult } from '../types/arbitration.js';

export class DeterministicEvaluator {
  public static evaluateAll(
    specs: DeterministicCheckSpec[],
    artifacts: DeliverableArtifact[]
  ): CheckResult[] {
    return specs.map((spec) => this.evaluateSingle(spec, artifacts));
  }

  public static evaluateSingle(
    spec: DeterministicCheckSpec,
    artifacts: DeliverableArtifact[]
  ): CheckResult {
    const targetArtifact = artifacts.find(
      (a) => a.name === spec.targetField || spec.targetField === '*' || spec.targetField === 'all'
    ) ?? artifacts[0];

    if (!targetArtifact) {
      return {
        checkId: spec.id,
        name: spec.name,
        passed: false,
        score: 0,
        weight: spec.weight ?? 1,
        message: `Target artifact '${spec.targetField}' not found in submission.`,
      };
    }

    switch (spec.type) {
      case 'HASH_EQUAL': {
        const computedSha256 = crypto
          .createHash('sha256')
          .update(targetArtifact.content)
          .digest('hex');

        const expected = String(spec.expectedValue ?? '').toLowerCase();
        const passed = expected.length === 64 && computedSha256.toLowerCase() === expected;

        return {
          checkId: spec.id,
          name: spec.name,
          passed,
          score: passed ? 100 : 0,
          weight: spec.weight ?? 1,
          message: passed
            ? `SHA-256 integrity verified (${computedSha256.substring(0, 16)}...)`
            : `Hash mismatch. Expected ${expected || '(missing)'}, got ${computedSha256}`,
          details: { computedSha256, expectedSha256: expected },
        };
      }

      case 'SYNTAX_VALID': {
        // P1 Fix 10: Real syntax validation using V8 bytecode compilation & JSON parser without executing untrusted code
        try {
          if (targetArtifact.type === 'DATASET' || targetArtifact.name.endsWith('.json')) {
            JSON.parse(targetArtifact.content);
            return {
              checkId: spec.id,
              name: spec.name,
              passed: true,
              score: 100,
              weight: spec.weight ?? 1,
              message: 'Valid JSON syntax confirmed via parser.',
            };
          }

          // For JavaScript / TypeScript deliverables, compile syntax into V8 AST
          const strippedModule = targetArtifact.content
            .replace(/^import\s+.*?['"].*?['"];?/gm, '')
            .replace(/^export\s+(default\s+)?/gm, '');

          new vm.Script(strippedModule, { filename: targetArtifact.name });

          return {
            checkId: spec.id,
            name: spec.name,
            passed: true,
            score: 100,
            weight: spec.weight ?? 1,
            message: 'AST syntax verified without runtime execution.',
          };
        } catch (err: any) {
          return {
            checkId: spec.id,
            name: spec.name,
            passed: false,
            score: 0,
            weight: spec.weight ?? 1,
            message: `Syntax validation failed: ${err.message}`,
            details: { syntaxError: err.message },
          };
        }
      }

      case 'JSON_SCHEMA': {
        // P1 Fix 10: Real recursive JSON Schema & type conformance validator
        try {
          const parsed = JSON.parse(targetArtifact.content);
          const validationIssues = this.validateJsonSchemaRecursive(parsed, spec.expectedValue, '$');

          const passed = validationIssues.length === 0;
          const score = passed ? 100 : Math.max(0, 100 - validationIssues.length * 25);

          return {
            checkId: spec.id,
            name: spec.name,
            passed,
            score,
            weight: spec.weight ?? 1,
            message: passed
              ? 'JSON deliverable conforms strictly to expected schema hierarchy and types.'
              : `JSON schema issues: ${validationIssues.join('; ')}`,
            details: { issues: validationIssues, passed },
          };
        } catch (err: any) {
          return {
            checkId: spec.id,
            name: spec.name,
            passed: false,
            score: 0,
            weight: spec.weight ?? 1,
            message: `JSON parse error: ${err.message}`,
          };
        }
      }

      case 'REGEX_MATCH': {
        try {
          const regex = new RegExp(String(spec.expectedValue));
          const passed = regex.test(targetArtifact.content);

          return {
            checkId: spec.id,
            name: spec.name,
            passed,
            score: passed ? 100 : 0,
            weight: spec.weight ?? 1,
            message: passed
              ? `Matched required regex pattern: ${spec.expectedValue}`
              : `Failed to match pattern: ${spec.expectedValue}`,
          };
        } catch (err: any) {
          return {
            checkId: spec.id,
            name: spec.name,
            passed: false,
            score: 0,
            weight: spec.weight ?? 1,
            message: `Invalid regex pattern: ${err.message}`,
          };
        }
      }

      case 'NUMERIC_THRESHOLD': {
        const fieldName = spec.targetField;
        const rawVal = targetArtifact.metadata?.[fieldName] ?? targetArtifact.content;
        const numVal = parseFloat(String(rawVal));
        const threshold = parseFloat(String(spec.expectedValue));

        if (isNaN(numVal)) {
          return {
            checkId: spec.id,
            name: spec.name,
            passed: false,
            score: 0,
            weight: spec.weight ?? 1,
            message: `Field '${fieldName}' did not resolve to a valid number. Got: '${rawVal}'`,
          };
        }

        const passed = numVal >= threshold;
        return {
          checkId: spec.id,
          name: spec.name,
          passed,
          score: passed ? 100 : 0,
          weight: spec.weight ?? 1,
          message: passed
            ? `Metric '${fieldName}' (${numVal}) meets threshold >= ${threshold}`
            : `Metric '${fieldName}' (${numVal}) fell below threshold ${threshold}`,
          details: { actual: numVal, threshold },
        };
      }

      case 'CUSTOM_ASSERTION':
      default: {
        const passed = targetArtifact.content.trim().length > 0;
        return {
          checkId: spec.id,
          name: spec.name,
          passed,
          score: passed ? 100 : 0,
          weight: spec.weight ?? 1,
          message: passed
            ? 'Artifact content presence assertion satisfied.'
            : 'Deliverable artifact is empty.',
        };
      }
    }
  }

  /**
   * Recursive validator supporting standard schemas and nested property dictionaries
   */
  private static validateJsonSchemaRecursive(
    data: any,
    schema: any,
    path: string
  ): string[] {
    const issues: string[] = [];

    if (schema === null || typeof schema !== 'object') {
      return issues;
    }

    // Standard JSON Schema format with properties / required
    if (schema.type === 'object' && schema.properties) {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        issues.push(`${path} expected object, got ${Array.isArray(data) ? 'array' : typeof data}`);
        return issues;
      }

      if (Array.isArray(schema.required)) {
        for (const reqKey of schema.required) {
          if (!(reqKey in data)) {
            issues.push(`${path}.${reqKey} is required but missing`);
          }
        }
      }

      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (propName in data) {
          issues.push(...this.validateJsonSchemaRecursive(data[propName], propSchema, `${path}.${propName}`));
        }
      }
      return issues;
    }

    // Key-value type map format { name: 'string', age: 'number', config: { ... } }
    for (const [key, expected] of Object.entries(schema)) {
      if (!(key in data)) {
        issues.push(`${path}.${key} is missing`);
        continue;
      }

      const val = data[key];
      if (typeof expected === 'string') {
        const actualType = Array.isArray(val) ? 'array' : typeof val;
        if (actualType !== expected) {
          issues.push(`${path}.${key} expected type '${expected}', got '${actualType}'`);
        }
      } else if (typeof expected === 'object' && expected !== null) {
        issues.push(...this.validateJsonSchemaRecursive(val, expected, `${path}.${key}`));
      }
    }

    return issues;
  }
}
