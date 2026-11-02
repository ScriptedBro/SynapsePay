import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { SynapseArbitrator } from '../../src/arbitration/arbitrator.js';
import { ContractSpec, SubmissionPayload } from '../../src/types/contract.js';

describe('Ed25519 Asymmetric Verdict Verification (P0 Fix 1 & 2)', () => {
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
      partialReleaseThreshold: 60,
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
        metadata: {},
      },
    ],
  };

  it('persists arbitrator keypair deterministically across restarts (P0 Fix 2)', () => {
    const arbitrator1 = new SynapseArbitrator(secret);
    const arbitrator2 = new SynapseArbitrator(secret);

    expect(arbitrator1.getPublicKey()).toBe(arbitrator2.getPublicKey());
    expect(arbitrator1.getFingerprint()).toBe(arbitrator2.getFingerprint());
    expect(arbitrator1.getFingerprint().length).toBe(64);
  });

  it('signs verdicts with Ed25519 public key and verifies against trusted key', async () => {
    const verdict = await arbitrator.arbitrate(sampleContract, sampleSubmission, 0);

    expect(verdict.arbitratorPublicKey).toBe(arbitrator.getPublicKey());
    expect(verdict.signedVerdictSignature).toBeDefined();
    expect(verdict.signedVerdictSignature.length).toBeGreaterThan(64);

    // Verify against trusted public key
    const isValid = SynapseArbitrator.verifyVerdictSignature(verdict, arbitrator.getPublicKey());
    expect(isValid).toBe(true);
  });

  it('rejects circular self-signed attacker verdicts (P0 Fix 1)', async () => {
    // Attacker generates their own keypair
    const { privateKey: attackerPriv, publicKey: attackerPub } = crypto.generateKeyPairSync('ed25519');
    const attackerPubHex = (attackerPub.export({ type: 'spki', format: 'der' }) as Buffer).toString('hex');

    const fakeVerdictData = {
      contractId: sampleContract.id,
      milestoneSequence: 1,
      decision: 'RELEASE' as const,
      overallScore: 100,
      payoutPercentage: 1.0,
      canRetry: false,
      evaluatedAt: new Date().toISOString(),
      deterministicResults: [],
      semanticResults: [],
      rationale: 'Attacker forged verdict claiming full release',
      arbitratorPublicKey: attackerPubHex, // Attacker embeds their own key
    };

    const sig = crypto.sign(null, Buffer.from(JSON.stringify(fakeVerdictData), 'utf-8'), attackerPriv);
    const attackerVerdict = {
      ...fakeVerdictData,
      signedVerdictSignature: sig.toString('hex'),
    };

    // When verified against trusted arbitrator key, attacker verdict MUST FAIL!
    const verifiedAgainstTrusted = SynapseArbitrator.verifyVerdictSignature(
      attackerVerdict,
      arbitrator.getPublicKey()
    );
    expect(verifiedAgainstTrusted).toBe(false);
  });

  it('detects tampering with verdict decision, score, or payout percentage', async () => {
    const verdict = await arbitrator.arbitrate(sampleContract, sampleSubmission, 0);

    // Tampering with decision
    const tamperedDecision = { ...verdict, decision: 'REJECT' as const };
    expect(SynapseArbitrator.verifyVerdictSignature(tamperedDecision, arbitrator.getPublicKey())).toBe(false);

    // Tampering with payoutPercentage
    const tamperedPayout = { ...verdict, payoutPercentage: 0.1 };
    expect(SynapseArbitrator.verifyVerdictSignature(tamperedPayout, arbitrator.getPublicKey())).toBe(false);

    // Tampering with overallScore
    const tamperedScore = { ...verdict, overallScore: 10 };
    expect(SynapseArbitrator.verifyVerdictSignature(tamperedScore, arbitrator.getPublicKey())).toBe(false);
  });
});
