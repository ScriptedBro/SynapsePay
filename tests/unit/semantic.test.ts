import { describe, it, expect } from 'vitest';
import { SemanticEvaluator } from '../../src/arbitration/semantic.js';
import { DeliverableArtifact, SemanticRubricSpec } from '../../src/types/contract.js';

describe('SemanticEvaluator', () => {
  const evaluator = new SemanticEvaluator(); // runs in deterministic heuristic mode without API key

  it('evaluates comprehensive documentation meeting rubric criteria', async () => {
    const rubric: SemanticRubricSpec = {
      id: 'rubric_arch_doc',
      name: 'Architecture Documentation Quality',
      description: 'Ensures the architecture guide clearly specifies component boundaries and security.',
      weight: 1,
      minScore: 75,
      instructions: 'Documentation must explain component architecture, boundaries, security, and data flow.',
    };

    const artifact: DeliverableArtifact = {
      name: 'Architecture.md',
      type: 'DOCUMENTATION',
      content: `
# Architecture Guide
This document details component boundaries, security enforcement, and data flow across services.
The system maintains cryptographic integrity across audit trails and encapsulates PayPal settlement.
      `,
    };

    const result = await evaluator.evaluateSingle(
      rubric,
      'System Documentation Task',
      'Provide comprehensive architecture specification.',
      [artifact]
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(rubric.minScore);
  });

  it('fails deliverable when content is insufficient or empty', async () => {
    const rubric: SemanticRubricSpec = {
      id: 'rubric_strict',
      name: 'Deep Technical Analysis',
      description: 'Requires exhaustive analysis of threat vectors.',
      weight: 1,
      minScore: 80,
      instructions: 'Exhaustive threat modeling and quantitative latency benchmarks.',
    };

    const emptyArtifact: DeliverableArtifact = {
      name: 'Doc.md',
      type: 'DOCUMENTATION',
      content: 'Too short',
    };

    const result = await evaluator.evaluateSingle(
      rubric,
      'Threat Modeling',
      'Perform detailed threat modeling.',
      [emptyArtifact]
    );

    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(rubric.minScore);
  });
});
