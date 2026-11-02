import crypto from 'node:crypto';
import { ContractSpec, SubmissionPayload } from '../types/contract.js';
import {
  ArbitrationDecision,
  ArbitrationVerdict,
  ArbitrationVerdictSchema,
  CheckResult,
} from '../types/arbitration.js';
import { DeterministicEvaluator } from './deterministic.js';
import { SemanticEvaluator } from './semantic.js';

export class SynapseArbitrator {
  private readonly semanticEvaluator: SemanticEvaluator;
  private readonly hmacSecret: string;

  constructor(hmacSecret: string, apiKey?: string, modelName: string = 'gpt-4o') {
    this.hmacSecret = hmacSecret;
    this.semanticEvaluator = new SemanticEvaluator(apiKey, modelName);
  }

  public async arbitrate(
    contract: ContractSpec,
    submission: SubmissionPayload,
    retriesUsed: number
  ): Promise<ArbitrationVerdict> {
    const { sla } = contract;

    // 1. Run Tier 1 Deterministic Checks
    const deterministicResults = DeterministicEvaluator.evaluateAll(
      sla.deterministicChecks,
      submission.artifacts
    );

    // 2. Run Tier 2 Semantic Quality Audit
    const semanticResults = await this.semanticEvaluator.evaluateAll(
      sla.semanticRubrics,
      sla.taskTitle,
      sla.taskDescription,
      submission.artifacts
    );

    // 3. Compute overall scoring
    const allResults: CheckResult[] = [...deterministicResults, ...semanticResults];
    const totalChecks = allResults.length;

    let overallScore = 100;
    if (totalChecks > 0) {
      const sumScores = allResults.reduce((acc, r) => acc + r.score, 0);
      overallScore = Math.round(sumScores / totalChecks);
    }

    // Check if any required deterministic check failed
    const hasRequiredFailure = deterministicResults.some((r) => {
      const spec = sla.deterministicChecks.find((s) => s.id === r.checkId);
      return spec?.required && !r.passed;
    });

    const passedOverall = !hasRequiredFailure && overallScore >= sla.minOverallScore;
    const canRetry = !passedOverall && retriesUsed < sla.maxArbitrationRetries;

    let decision: ArbitrationDecision;
    let payoutPercentage = 0;

    if (passedOverall) {
      decision = ArbitrationDecision.RELEASE;
      payoutPercentage = 1.0;
    } else if (canRetry) {
      decision = ArbitrationDecision.REJECT; // triggers REMEDIATION_REQUIRED in state machine
      payoutPercentage = 0;
    } else {
      decision = ArbitrationDecision.REJECT; // terminal rejection -> full refund
      payoutPercentage = 0;
    }

    const failedCheckNames = allResults.filter((r) => !r.passed).map((r) => r.name);
    const rationale = passedOverall
      ? `Deliverable passed all required SLA criteria with composite score ${overallScore}/100.`
      : `Deliverable failed SLA verification (Score: ${overallScore}/100). Failed items: ${
          failedCheckNames.join(', ') || 'Composite score below threshold'
        }.${canRetry ? ` Retries remaining: ${sla.maxArbitrationRetries - retriesUsed}.` : ' No retries remaining.'}`;

    const timestamp = new Date().toISOString();

    const verdictPayload = {
      contractId: contract.id,
      milestoneSequence: submission.milestoneSequence,
      decision,
      overallScore,
      payoutPercentage,
      canRetry,
      evaluatedAt: timestamp,
      deterministicResults,
      semanticResults,
      rationale,
    };

    const payloadString = JSON.stringify(verdictPayload);
    const signedHash = crypto.createHmac('sha256', this.hmacSecret).update(payloadString).digest('hex');

    return ArbitrationVerdictSchema.parse({
      ...verdictPayload,
      signedHash,
    });
  }
}
