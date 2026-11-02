import crypto from 'node:crypto';
import { ContractSpec, SubmissionPayload } from '../types/contract.js';
import {
  ArbitrationVerdict,
  ArbitrationDecision,
  CheckResult,
  ArbitrationVerdictSchema,
} from '../types/arbitration.js';
import { DeterministicEvaluator } from './deterministic.js';
import { SemanticEvaluator } from './semantic.js';

export class SynapseArbitrator {
  private readonly semanticEvaluator: SemanticEvaluator;
  private readonly privateKey: crypto.KeyObject;
  private readonly publicKeyHex: string;
  private readonly fingerprint: string;

  constructor(
    hmacSecret?: string,
    apiKey?: string,
    modelName: string = 'gpt-4o',
    customPrivateKeyHexOrPem?: string
  ) {
    this.semanticEvaluator = new SemanticEvaluator(apiKey, modelName);

    if (customPrivateKeyHexOrPem) {
      if (customPrivateKeyHexOrPem.includes('BEGIN PRIVATE KEY')) {
        this.privateKey = crypto.createPrivateKey(customPrivateKeyHexOrPem);
      } else {
        const seed = Buffer.from(customPrivateKeyHexOrPem, 'hex');
        const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
        const privKeyDer = Buffer.concat([pkcs8Prefix, seed]);
        this.privateKey = crypto.createPrivateKey({ key: privKeyDer, format: 'der', type: 'pkcs8' });
      }
    } else if (process.env.ARBITRATOR_PRIVATE_KEY) {
      const envKey = process.env.ARBITRATOR_PRIVATE_KEY;
      if (envKey.includes('BEGIN PRIVATE KEY')) {
        this.privateKey = crypto.createPrivateKey(envKey);
      } else {
        const seed = Buffer.from(envKey, 'hex');
        const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
        const privKeyDer = Buffer.concat([pkcs8Prefix, seed]);
        this.privateKey = crypto.createPrivateKey({ key: privKeyDer, format: 'der', type: 'pkcs8' });
      }
    } else {
      // Deterministic, persistent Ed25519 keypair derived from secret (P0 Fix 2)
      // Never random ephemeral across restarts!
      const seed = crypto
        .createHash('sha256')
        .update('SYNAPSE_ARBITRATOR_ED25519_V1:' + (hmacSecret || 'SYNAPSE_DEFAULT_SECRET_KEY_32_CHARS'))
        .digest();
      const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
      const privKeyDer = Buffer.concat([pkcs8Prefix, seed]);
      this.privateKey = crypto.createPrivateKey({ key: privKeyDer, format: 'der', type: 'pkcs8' });
    }

    const pubKey = crypto.createPublicKey(this.privateKey);
    const pubDer = pubKey.export({ type: 'spki', format: 'der' }) as Buffer;
    this.publicKeyHex = pubDer.toString('hex');
    this.fingerprint = crypto.createHash('sha256').update(pubDer).digest('hex');
  }

  public getPublicKey(): string {
    return this.publicKeyHex;
  }

  public getFingerprint(): string {
    return this.fingerprint;
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

    // 3. Compute weighted composite score using defined check weights (Fix for Claim 10)
    const allResults: CheckResult[] = [...deterministicResults, ...semanticResults];
    let overallScore = 100;

    if (allResults.length > 0) {
      const totalWeight = allResults.reduce((acc, r) => acc + (r.weight || 1), 0);
      const weightedSum = allResults.reduce((acc, r) => acc + r.score * (r.weight || 1), 0);
      overallScore = Math.round(weightedSum / (totalWeight || 1));
    }

    // Check required deterministic checks
    const hasRequiredFailure = deterministicResults.some((r) => {
      const spec = sla.deterministicChecks.find((s) => s.id === r.checkId);
      return spec?.required && !r.passed;
    });

    const hasFailedClosed = semanticResults.some((r) => r.details?.failedClosed);

    const passedFull = !hasRequiredFailure && !hasFailedClosed && overallScore >= sla.minOverallScore;
    const partialThreshold = sla.partialReleaseThreshold ?? 60;
    const passedPartial = !hasRequiredFailure && !hasFailedClosed && overallScore >= partialThreshold && overallScore < sla.minOverallScore;

    const canRetry = !passedFull && !passedPartial && !hasFailedClosed && retriesUsed < sla.maxArbitrationRetries;

    let decision: ArbitrationDecision;
    let payoutPercentage = 0;

    if (hasFailedClosed) {
      // P1 Fix 11: Fail closed if AI provider failed
      decision = ArbitrationDecision.DISPUTE;
      payoutPercentage = 0;
    } else if (passedFull) {
      decision = ArbitrationDecision.RELEASE;
      payoutPercentage = 1.0;
    } else if (passedPartial) {
      // Proportional split (Fix for Claim 2)
      decision = ArbitrationDecision.PARTIAL_RELEASE;
      payoutPercentage = Math.round((overallScore / 100) * 100) / 100;
    } else if (canRetry) {
      decision = ArbitrationDecision.REJECT;
      payoutPercentage = 0;
    } else {
      // Contested / edge breach with zero retries triggers formal DISPUTE (Fix for Claim 2)
      if (overallScore >= 40) {
        decision = ArbitrationDecision.DISPUTE;
        payoutPercentage = 0;
      } else {
        decision = ArbitrationDecision.REJECT;
        payoutPercentage = 0;
      }
    }

    const failedCheckNames = allResults.filter((r) => !r.passed).map((r) => r.name);
    let rationale = '';

    if (hasFailedClosed) {
      rationale = `Arbitration LLM evaluation failed closed to prevent unverified fund release. Moved to DISPUTE state for manual/bilateral resolution.`;
    } else if (decision === ArbitrationDecision.RELEASE) {
      rationale = `Deliverable satisfied all required SLA criteria with composite weighted score ${overallScore}/100. Full payout authorized.`;
    } else if (decision === ArbitrationDecision.PARTIAL_RELEASE) {
      rationale = `Deliverable achieved partial fulfillment with composite weighted score ${overallScore}/100 (Threshold: ${partialThreshold}/100). Proportional settlement of ${(payoutPercentage * 100).toFixed(0)}% authorized; remainder returned to buyer.`;
    } else if (decision === ArbitrationDecision.DISPUTE) {
      rationale = `Deliverable fell below standard threshold (${overallScore}/100) with zero retries remaining. Contested deliverable routed to DISPUTE state for bilateral resolution or arbitrator split.`;
    } else {
      rationale = `Deliverable failed SLA verification (Score: ${overallScore}/100). Failed checks: ${
        failedCheckNames.join(', ') || 'Composite score below threshold'
      }.${canRetry ? ` Retries remaining: ${sla.maxArbitrationRetries - retriesUsed}.` : ' No retries remaining. Contract eligible for void/refund.'}`;
    }

    const evaluatedAt = new Date().toISOString();

    const canonicalData = {
      contractId: contract.id ?? '',
      milestoneSequence: submission.milestoneSequence,
      decision,
      overallScore,
      payoutPercentage,
      canRetry,
      evaluatedAt,
      deterministicResults,
      semanticResults,
      rationale,
      arbitratorPublicKey: this.publicKeyHex,
    };

    // Ed25519 asymmetric signature for zero-trust independent verification (P0 Fix 1 & 2)
    const dataBuffer = Buffer.from(JSON.stringify(canonicalData), 'utf-8');
    const signature = crypto.sign(null, dataBuffer, this.privateKey);
    const signedVerdictSignature = signature.toString('hex');

    return ArbitrationVerdictSchema.parse({
      ...canonicalData,
      signedVerdictSignature,
    });
  }

  /**
   * Independently verifies any verdict using a trusted arbitrator public key (P0 Fix 1).
   * Circular self-asserted keys are rejected!
   */
  public static verifyVerdictSignature(
    verdict: ArbitrationVerdict,
    trustedPublicKeyHex: string
  ): boolean {
    try {
      if (!trustedPublicKeyHex) return false;
      // P0 Fix 1: Pin trusted public key from config, reject self-signed attacker payloads!
      if (verdict.arbitratorPublicKey !== trustedPublicKeyHex) {
        return false;
      }

      const canonicalData = {
        contractId: verdict.contractId,
        milestoneSequence: verdict.milestoneSequence,
        decision: verdict.decision,
        overallScore: verdict.overallScore,
        payoutPercentage: verdict.payoutPercentage,
        canRetry: verdict.canRetry,
        evaluatedAt: verdict.evaluatedAt,
        deterministicResults: verdict.deterministicResults,
        semanticResults: verdict.semanticResults,
        rationale: verdict.rationale,
        arbitratorPublicKey: verdict.arbitratorPublicKey,
      };

      const dataBuffer = Buffer.from(JSON.stringify(canonicalData), 'utf-8');
      const pubKeyDer = Buffer.from(trustedPublicKeyHex, 'hex');
      const publicKey = crypto.createPublicKey({
        key: pubKeyDer,
        type: 'spki',
        format: 'der',
      });

      const signature = Buffer.from(verdict.signedVerdictSignature, 'hex');
      return crypto.verify(null, dataBuffer, publicKey, signature);
    } catch {
      return false;
    }
  }
}
