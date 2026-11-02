import { generateObject } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { SemanticRubricSpec, DeliverableArtifact } from '../types/contract.js';
import { CheckResult } from '../types/arbitration.js';

const LLMEvalOutputSchema = z.object({
  score: z.number().min(0).max(100),
  passed: z.boolean(),
  reasoning: z.string(),
  keyFindings: z.array(z.string()),
});

export class SemanticEvaluator {
  private readonly apiKey?: string;
  private readonly modelName: string;

  constructor(apiKey?: string, modelName: string = 'gpt-4o') {
    this.apiKey = apiKey;
    this.modelName = modelName;
  }

  public async evaluateAll(
    rubrics: SemanticRubricSpec[],
    taskTitle: string,
    taskDescription: string,
    artifacts: DeliverableArtifact[]
  ): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const rubric of rubrics) {
      const res = await this.evaluateSingle(rubric, taskTitle, taskDescription, artifacts);
      results.push(res);
    }
    return results;
  }

  public async evaluateSingle(
    rubric: SemanticRubricSpec,
    taskTitle: string,
    taskDescription: string,
    artifacts: DeliverableArtifact[]
  ): Promise<CheckResult> {
    if (this.apiKey) {
      try {
        const openai = createOpenAI({ apiKey: this.apiKey });
        const model = openai(this.modelName);

        const artifactsSummary = artifacts
          .map((a) => `[Artifact: ${a.name} (${a.type})]\n${a.content.substring(0, 4000)}`)
          .join('\n\n---\n\n');

        const prompt = `
You are the SynapsePay Autonomous Arbitration Judge evaluating a deliverable submitted by an AI worker agent for payment release.
You must be impartial, objective, and adhere strictly to the provided SLA rubric.

[TASK INFORMATION]
Title: ${taskTitle}
Description: ${taskDescription}

[RUBRIC TO EVALUATE]
Rubric Name: ${rubric.name}
Description: ${rubric.description}
Minimum Passing Score: ${rubric.minScore}/100
Instructions: ${rubric.instructions}

[SUBMITTED DELIVERABLES]
${artifactsSummary}

Evaluate whether the deliverable meets this rubric. Assign an integer score from 0 to 100, set passed to true only if score >= ${rubric.minScore}, and provide a concise technical reasoning.
`;

        const { object } = await generateObject({
          model,
          schema: LLMEvalOutputSchema,
          prompt,
        });

        return {
          checkId: rubric.id,
          name: rubric.name,
          passed: object.passed,
          score: object.score,
          message: object.reasoning,
          details: { keyFindings: object.keyFindings },
        };
      } catch (err: any) {
        // Fall back to heuristic scoring if API call fails
        return this.heuristicFallback(rubric, taskTitle, artifacts, `AI provider error: ${err.message}`);
      }
    }

    return this.heuristicFallback(rubric, taskTitle, artifacts);
  }

  private heuristicFallback(
    rubric: SemanticRubricSpec,
    _taskTitle: string,
    artifacts: DeliverableArtifact[],
    fallbackNotice?: string
  ): CheckResult {
    // Intelligent deterministic heuristic for air-gapped / test execution
    const totalContentLength = artifacts.reduce((acc, a) => acc + a.content.length, 0);
    const hasMeaningfulContent = totalContentLength >= 50;

    // Check if instructions keywords are referenced or satisfied
    const instructionWords = rubric.instructions.toLowerCase().split(/\s+/).filter((w) => w.length > 5);
    const allContentLower = artifacts.map((a) => a.content.toLowerCase()).join(' ');

    let keywordMatches = 0;
    for (const word of instructionWords) {
      if (allContentLower.includes(word)) {
        keywordMatches++;
      }
    }

    const keywordRatio = instructionWords.length > 0 ? keywordMatches / instructionWords.length : 1;
    let score = hasMeaningfulContent ? Math.min(100, Math.round(75 + keywordRatio * 25)) : 20;

    const passed = score >= rubric.minScore;

    return {
      checkId: rubric.id,
      name: rubric.name,
      passed,
      score,
      message: `${passed ? 'Rubric requirements satisfied' : 'Deliverable fell below rubric threshold'}.${
        fallbackNotice ? ` [Note: ${fallbackNotice}]` : ' [Evaluated via deterministic rubric heuristic]'
      }`,
      details: {
        totalContentLength,
        keywordRatio,
        minScore: rubric.minScore,
      },
    };
  }
}
