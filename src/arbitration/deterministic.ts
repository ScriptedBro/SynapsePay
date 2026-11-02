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
        message: `Target artifact '${spec.targetField}' not found in submission.`,
      };
    }

    switch (spec.type) {
      case 'HASH_EQUAL': {
        const computedSha256 = crypto
          .createHash('sha256')
          .update(targetArtifact.content)
          .digest('hex');
        
        const expected = String(spec.expectedValue).toLowerCase();
        const passed = computedSha256.toLowerCase() === expected;

        return {
          checkId: spec.id,
          name: spec.name,
          passed,
          score: passed ? 100 : 0,
          message: passed
            ? `SHA-256 integrity verified (${computedSha256.substring(0, 16)}...)`
            : `Hash mismatch. Expected ${expected}, got ${computedSha256}`,
          details: { computedSha256, expectedSha256: expected },
        };
      }

      case 'JSON_SCHEMA': {
        try {
          const parsed = JSON.parse(targetArtifact.content);
          if (typeof spec.expectedValue === 'object' && spec.expectedValue !== null) {
            const requiredKeys = Object.keys(spec.expectedValue);
            const missingKeys = requiredKeys.filter((key) => !(key in parsed));
            const passed = missingKeys.length === 0;

            return {
              checkId: spec.id,
              name: spec.name,
              passed,
              score: passed ? 100 : Math.max(0, 100 - missingKeys.length * 25),
              message: passed
                ? 'JSON structure conforms to expected schema.'
                : `JSON missing required fields: ${missingKeys.join(', ')}`,
              details: { missingKeys },
            };
          }

          return {
            checkId: spec.id,
            name: spec.name,
            passed: true,
            score: 100,
            message: 'Valid JSON payload syntax verified.',
          };
        } catch (err: any) {
          return {
            checkId: spec.id,
            name: spec.name,
            passed: false,
            score: 0,
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
            message: `Value '${numVal}' or threshold '${threshold}' is not numeric.`,
          };
        }

        const passed = numVal >= threshold;
        return {
          checkId: spec.id,
          name: spec.name,
          passed,
          score: passed ? 100 : Math.max(0, Math.round((numVal / threshold) * 100)),
          message: passed
            ? `Threshold satisfied: ${numVal} >= ${threshold}`
            : `Threshold breached: ${numVal} < ${threshold}`,
          details: { actual: numVal, threshold },
        };
      }

      case 'CUSTOM_ASSERTION':
      default: {
        const passed = targetArtifact.content.length > 0;
        return {
          checkId: spec.id,
          name: spec.name,
          passed,
          score: passed ? 100 : 0,
          message: passed ? 'Default content presence check passed.' : 'Empty content payload.',
        };
      }
    }
  }
}
