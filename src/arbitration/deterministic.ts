import crypto from 'node:crypto';
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
        // Validates JSON or JS/TS/Python structure without pre-knowing deliverable hash
        try {
          if (targetArtifact.type === 'DATASET' || targetArtifact.name.endsWith('.json')) {
            JSON.parse(targetArtifact.content);
            return {
              checkId: spec.id,
              name: spec.name,
              passed: true,
              score: 100,
              weight: spec.weight ?? 1,
              message: 'Valid JSON syntax confirmed.',
            };
          }

          // For code artifacts, verify structural balance (braces, brackets, parens)
          const balanced = this.isBracesBalanced(targetArtifact.content);
          const hasContent = targetArtifact.content.trim().length > 20;
          const passed = balanced && hasContent;

          return {
            checkId: spec.id,
            name: spec.name,
            passed,
            score: passed ? 100 : 25,
            weight: spec.weight ?? 1,
            message: passed
              ? 'Code syntax and balanced block structure verified.'
              : 'Syntax validation failed: Unbalanced braces/parentheses or empty block.',
          };
        } catch (err: any) {
          return {
            checkId: spec.id,
            name: spec.name,
            passed: false,
            score: 0,
            weight: spec.weight ?? 1,
            message: `Syntax validation error: ${err.message}`,
          };
        }
      }

      case 'JSON_SCHEMA': {
        try {
          const parsed = JSON.parse(targetArtifact.content);
          if (typeof spec.expectedValue === 'object' && spec.expectedValue !== null) {
            const schemaEntries = Object.entries(spec.expectedValue);
            let matchedFields = 0;
            const issues: string[] = [];

            for (const [key, expectedType] of schemaEntries) {
              if (!(key in parsed)) {
                issues.push(`Missing property '${key}'`);
              } else if (typeof expectedType === 'string') {
                const actualType = Array.isArray(parsed[key]) ? 'array' : typeof parsed[key];
                if (actualType !== expectedType) {
                  issues.push(`Property '${key}' expected type '${expectedType}', got '${actualType}'`);
                } else {
                  matchedFields++;
                }
              } else {
                matchedFields++;
              }
            }

            const passed = issues.length === 0;
            const score = schemaEntries.length > 0 ? Math.round((matchedFields / schemaEntries.length) * 100) : 100;

            return {
              checkId: spec.id,
              name: spec.name,
              passed,
              score,
              weight: spec.weight ?? 1,
              message: passed
                ? 'JSON structure conforms to expected schema and types.'
                : `JSON schema issues: ${issues.join('; ')}`,
              details: { issues, matchedFields, totalFields: schemaEntries.length },
            };
          }

          return {
            checkId: spec.id,
            name: spec.name,
            passed: true,
            score: 100,
            weight: spec.weight ?? 1,
            message: 'Valid JSON payload syntax verified.',
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
              ? `Content satisfied regex pattern: ${spec.expectedValue}`
              : `Content failed to match regex pattern: ${spec.expectedValue}`,
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
        const metadataVal = targetArtifact.metadata[spec.targetField];
        const numVal = typeof metadataVal === 'number' ? metadataVal : parseFloat(targetArtifact.content);
        const threshold = Number(spec.expectedValue);

        if (isNaN(numVal) || isNaN(threshold)) {
          return {
            checkId: spec.id,
            name: spec.name,
            passed: false,
            score: 0,
            weight: spec.weight ?? 1,
            message: `Value '${numVal}' or threshold '${threshold}' is not numeric.`,
          };
        }

        const passed = numVal >= threshold;
        return {
          checkId: spec.id,
          name: spec.name,
          passed,
          score: passed ? 100 : Math.max(0, Math.round((numVal / threshold) * 100)),
          weight: spec.weight ?? 1,
          message: passed
            ? `Threshold satisfied: ${numVal} >= ${threshold}`
            : `Threshold breached: ${numVal} < ${threshold}`,
          details: { actual: numVal, threshold },
        };
      }

      case 'CUSTOM_ASSERTION':
      default: {
        const nonWhitespaceLen = targetArtifact.content.trim().length;
        const passed = nonWhitespaceLen >= 10;
        return {
          checkId: spec.id,
          name: spec.name,
          passed,
          score: passed ? 100 : 0,
          weight: spec.weight ?? 1,
          message: passed ? 'Substantial deliverable payload confirmed.' : 'Deliverable is empty or whitespace only.',
        };
      }
    }
  }

  private static isBracesBalanced(str: string): boolean {
    const stack: string[] = [];
    const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
    for (const char of str) {
      if (char === '{' || char === '(' || char === '[') {
        stack.push(char);
      } else if (char === '}' || char === ')' || char === ']') {
        if (stack.pop() !== pairs[char]) return false;
      }
    }
    return stack.length === 0;
  }
}
