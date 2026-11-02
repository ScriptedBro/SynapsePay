import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { DeterministicEvaluator } from '../../src/arbitration/deterministic.js';
import { DeliverableArtifact, DeterministicCheckSpec } from '../../src/types/contract.js';

describe('DeterministicEvaluator', () => {
  it('correctly validates SHA-256 hash equality', () => {
    const content = 'export function add(a: number, b: number) { return a + b; }';
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

    const artifact: DeliverableArtifact = {
      name: 'add.ts',
      type: 'CODE',
      content,
    };

    const validSpec: DeterministicCheckSpec = {
      id: 'check_hash_1',
      name: 'Integrity Check',
      type: 'HASH_EQUAL',
      targetField: 'add.ts',
      expectedValue: sha256,
      required: true,
    };

    const resValid = DeterministicEvaluator.evaluateSingle(validSpec, [artifact]);
    expect(resValid.passed).toBe(true);
    expect(resValid.score).toBe(100);

    const invalidSpec: DeterministicCheckSpec = {
      ...validSpec,
      expectedValue: '0'.repeat(64),
    };

    const resInvalid = DeterministicEvaluator.evaluateSingle(invalidSpec, [artifact]);
    expect(resInvalid.passed).toBe(false);
    expect(resInvalid.score).toBe(0);
  });

  it('validates JSON Schema structure and catches missing keys', () => {
    const validJson = JSON.stringify({
      status: 'success',
      data: { model: 'gpt-4o', latencyMs: 120 },
    });

    const artifact: DeliverableArtifact = {
      name: 'result.json',
      type: 'DATASET',
      content: validJson,
    };

    const spec: DeterministicCheckSpec = {
      id: 'check_json_1',
      name: 'JSON Schema Compliance',
      type: 'JSON_SCHEMA',
      targetField: 'result.json',
      expectedValue: { status: 'string', data: 'object' },
      required: true,
    };

    const res = DeterministicEvaluator.evaluateSingle(spec, [artifact]);
    expect(res.passed).toBe(true);
    expect(res.score).toBe(100);

    const incompleteJson = JSON.stringify({ status: 'success' });
    const resIncomplete = DeterministicEvaluator.evaluateSingle(spec, [
      { ...artifact, content: incompleteJson },
    ]);
    expect(resIncomplete.passed).toBe(false);
    expect(resIncomplete.score).toBeLessThan(100);
  });

  it('validates regex patterns across artifact content', () => {
    const content = 'SYNAPSE_PAY_VERIFIED_SIGNATURE_9921';
    const artifact: DeliverableArtifact = {
      name: 'output.txt',
      type: 'LOGS',
      content,
    };

    const spec: DeterministicCheckSpec = {
      id: 'check_regex_1',
      name: 'Signature Format Check',
      type: 'REGEX_MATCH',
      targetField: 'output.txt',
      expectedValue: '^SYNAPSE_PAY_VERIFIED_[A-Z0-9_]+$',
      required: true,
    };

    const res = DeterministicEvaluator.evaluateSingle(spec, [artifact]);
    expect(res.passed).toBe(true);
    expect(res.score).toBe(100);

    const failSpec: DeterministicCheckSpec = {
      ...spec,
      expectedValue: '^ERROR_',
    };
    const failRes = DeterministicEvaluator.evaluateSingle(failSpec, [artifact]);
    expect(failRes.passed).toBe(false);
  });

  it('validates numeric thresholds from metadata', () => {
    const artifact: DeliverableArtifact = {
      name: 'coverage.json',
      type: 'LOGS',
      content: '92.5',
      metadata: { unitTestCoverage: 92.5 },
    };

    const spec: DeterministicCheckSpec = {
      id: 'check_num_1',
      name: 'Test Coverage Threshold',
      type: 'NUMERIC_THRESHOLD',
      targetField: 'unitTestCoverage',
      expectedValue: 85,
      required: true,
    };

    const res = DeterministicEvaluator.evaluateSingle(spec, [artifact]);
    expect(res.passed).toBe(true);
    expect(res.score).toBe(100);

    const failSpec: DeterministicCheckSpec = {
      ...spec,
      expectedValue: 95,
    };
    const failRes = DeterministicEvaluator.evaluateSingle(failSpec, [artifact]);
    expect(failRes.passed).toBe(false);
  });

  it('validates syntax for generative work via SYNTAX_VALID check (Claim 10)', () => {
    const validJsonArtifact: DeliverableArtifact = {
      name: 'output.json',
      type: 'DATASET',
      content: '{"model": "gpt-4o", "confidence": 0.98, "tokens": 450}',
    };

    const syntaxSpec: DeterministicCheckSpec = {
      id: 'check_syntax_1',
      name: 'Valid JSON Syntax',
      type: 'SYNTAX_VALID',
      targetField: 'output.json',
      required: true,
      weight: 2,
    };

    const res = DeterministicEvaluator.evaluateSingle(syntaxSpec, [validJsonArtifact]);
    expect(res.passed).toBe(true);
    expect(res.score).toBe(100);
    expect(res.weight).toBe(2);

    const brokenJsonArtifact: DeliverableArtifact = {
      name: 'broken.json',
      type: 'DATASET',
      content: '{"model": "gpt-4o", incomplete json',
    };

    const failRes = DeterministicEvaluator.evaluateSingle(syntaxSpec, [brokenJsonArtifact]);
    expect(failRes.passed).toBe(false);
    expect(failRes.score).toBe(0);
  });

  it('validates JavaScript/TypeScript syntax via V8 bytecode compilation (P1 Fix 10)', () => {
    const validJsArtifact: DeliverableArtifact = {
      name: 'service.ts',
      type: 'CODE',
      content: 'export function calculateTotal(items) { return items.reduce((a, b) => a + b, 0); }',
    };

    const syntaxSpec: DeterministicCheckSpec = {
      id: 'chk_v8_syntax',
      name: 'V8 Syntax Check',
      type: 'SYNTAX_VALID',
      targetField: 'service.ts',
      required: true,
    };

    const resValid = DeterministicEvaluator.evaluateSingle(syntaxSpec, [validJsArtifact]);
    expect(resValid.passed).toBe(true);
    expect(resValid.score).toBe(100);

    const brokenJsArtifact: DeliverableArtifact = {
      name: 'service.ts',
      type: 'CODE',
      content: 'function broken(a, b { return a +; }', // Missing closing paren & bad expression
    };

    const resBroken = DeterministicEvaluator.evaluateSingle(syntaxSpec, [brokenJsArtifact]);
    expect(resBroken.passed).toBe(false);
    expect(resBroken.score).toBe(0);
    expect(resBroken.details).toHaveProperty('syntaxError');
  });

  it('validates nested recursive JSON schemas (P1 Fix 10)', () => {
    const validNestedArtifact: DeliverableArtifact = {
      name: 'metrics.json',
      type: 'DATASET',
      content: JSON.stringify({
        cluster: 'us-west-2',
        telemetry: {
          uptimeSeconds: 84000,
          nodes: ['node-1', 'node-2'],
        },
      }),
    };

    const nestedSchemaSpec: DeterministicCheckSpec = {
      id: 'chk_nested_schema',
      name: 'Nested Telemetry Schema',
      type: 'JSON_SCHEMA',
      targetField: 'metrics.json',
      expectedValue: {
        cluster: 'string',
        telemetry: {
          uptimeSeconds: 'number',
          nodes: 'array',
        },
      },
      required: true,
    };

    const res = DeterministicEvaluator.evaluateSingle(nestedSchemaSpec, [validNestedArtifact]);
    expect(res.passed).toBe(true);
    expect(res.score).toBe(100);

    const invalidNestedArtifact: DeliverableArtifact = {
      name: 'metrics.json',
      type: 'DATASET',
      content: JSON.stringify({
        cluster: 'us-west-2',
        telemetry: {
          uptimeSeconds: 'not-a-number', // Type mismatch in nested field!
        },
      }),
    };

    const resInvalid = DeterministicEvaluator.evaluateSingle(nestedSchemaSpec, [invalidNestedArtifact]);
    expect(resInvalid.passed).toBe(false);
    expect(resInvalid.details.issues.length).toBeGreaterThan(0);
  });
});
