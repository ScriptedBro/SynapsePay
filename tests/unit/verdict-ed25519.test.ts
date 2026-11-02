import { describe, it, expect } from 'vitest';
import { SynapseArbitrator } from '../../src/arbitration/arbitrator.js';
import { ContractSpec, SubmissionPayload } from '../../src/types/contract.js';

describe('Ed25519 Asymmetric Verdict Verification (Claim 8)', () => {
  const secret = 'test_audit_secret_32_characters_long_1234';
  const arbitrator = new SynapseArbitrator(secret);

  const sampleContract: ContractSpec = {
    id: 'e1111111-e89b-12d3-a456-426614174000',
    buyer: {
      id: 'e2222222-e89b-12d3-a456-426614174001',
      role: 'BUYER',
      name: 'Buyer Agent',
      paypalAccount: 'buyer@paypal.com',
    },
    worker: {
      id: 'e3333333-e89b-12d3-a456-426614174002',
      role: 'WORKER',
      name: 'Worker Agent',
      paypalAccount: 'worker@paypal.com',
    },
    totalAmountInCents: 5000,
    currency: 'USD',
    sla: {
      slaId: 'e4444444-e89b-12d3-a456-426614174003',
      taskTitle: 'Data Extraction',
      taskDescription: 'Extract 10 items into valid JSON',
      maxDeliverySeconds: 3600,
      maxArbitrationRetries: 2,
      minOverallScore: 80,
      deterministicChecks: [],
      semanticRubrics: [],
    },
    milestones: [
      {
        sequence: 1,
        name: 'Delivery',
        amountInCents: 5000,
        currency: 'USD',
        status: 'PENDING',
      },
    ],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    metadata: {},
  };

  const sampleSubmission: SubmissionPayload = {
    contractId: sampleContract.id,
    workerId: sampleContract.worker!.id,
    milestoneSequence: 1,
    submittedAt: new Date().toISOString(),
    artifacts: [
      {
        name: 'data.json',
        type: 'DATASET',
        content: '{"items": [1, 2, 3]}',
      },
    ],
  };

  it('signs verdicts with Ed25519 public key embedded', async () => {
    const verdict = await arbitrator.arbitrate(sampleContract, sampleSubmission, 0);

    expect(verdict.arbitratorPublicKey).toBeDefined();
    expect(verdict.signedVerdictSignature).toBeDefined();
    expect(verdict.signedVerdictSignature.length).toBeGreaterThan(64);

    // Verify offline with public key
    const isValid = SynapseArbitrator.verifyVerdictSignature(verdict);
    expect(isValid).toBe(true);
  });

  it('detects tampering with verdict decision or payout percentage', async () => {
    const verdict = await arbitrator.arbitrate(sampleContract, sampleSubmission, 0);

    // Tampering with decision
    const tamperedDecision = { ...verdict, decision: 'REJECT' as const };
    expect(SynapseArbitrator.verifyVerdictSignature(tamperedDecision)).toBe(false);

    // Tampering with payoutPercentage
    const tamperedPayout = { ...verdict, payoutPercentage: 0.1 };
    expect(SynapseArbitrator.verifyVerdictSignature(tamperedPayout)).toBe(false);

    // Tampering with overallScore
    const tamperedScore = { ...verdict, overallScore: 10 };
    expect(SynapseArbitrator.verifyVerdictSignature(tamperedScore)).toBe(false);
  });

  it('rejects forged signature from another keypair', async () => {
    const otherArbitrator = new SynapseArbitrator('completely_different_secret_key_32_chars');
    const otherVerdict = await otherArbitrator.arbitrate(sampleContract, sampleSubmission, 0);

    // Swap signatures
    const forgedVerdict = {
      ...otherVerdict,
      arbitratorPublicKey: arbitrator.getPublicKey(), // Claimed to be signed by arbitrator 1
      signedVerdictSignature: otherVerdict.signedVerdictSignature, // Actually signed by arbitrator 2
    };

    expect(SynapseArbitrator.verifyVerdictSignature(forgedVerdict)).toBe(false);
  });
});
