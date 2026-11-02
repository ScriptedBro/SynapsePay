import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { ContractManager } from '../../src/core/contract-manager.js';
import { SynapseArbitrator } from '../../src/arbitration/arbitrator.js';
import { PayPalOrdersManager } from '../../src/paypal/orders.js';
import { PayPalPayoutsManager } from '../../src/paypal/payouts.js';
import { PayPalClient } from '../../src/paypal/client.js';
import { ContractSpec, Participant, SubmissionPayload } from '../../src/types/contract.js';
import { EscrowState } from '../../src/types/escrow.js';

describe('Contract Lifecycle Integration', () => {
  const secret = 'super_secure_audit_secret_key_32_characters';

  function createTestSetup() {
    const mockClient = new PayPalClient({
      clientId: 'mock_client',
      clientSecret: 'mock_secret',
      mode: 'sandbox',
    });

    const ordersManager = new PayPalOrdersManager(mockClient);
    const payoutsManager = new PayPalPayoutsManager(mockClient);

    vi.spyOn(ordersManager, 'createAuthorizationOrder').mockResolvedValue({
      orderId: 'ORD_TEST_MOCK_123',
      status: 'CREATED',
      approvalUrl: 'https://sandbox.paypal.com/checkoutnow?token=ORD_TEST_MOCK_123',
    });

    vi.spyOn(ordersManager, 'captureAuthorization').mockResolvedValue({
      captureId: 'CAP_TEST_456',
      status: 'COMPLETED',
      amount: { value: '100.00', currency_code: 'USD' },
    });

    vi.spyOn(ordersManager, 'voidAuthorization').mockResolvedValue(true);
    vi.spyOn(ordersManager, 'refundCapture').mockResolvedValue({
      refundId: 'REF_TEST_123',
      status: 'COMPLETED',
      amount: { value: '100.00', currency_code: 'USD' },
    });

    vi.spyOn(payoutsManager, 'executeMilestonePayout').mockResolvedValue({
      payoutBatchId: 'BATCH_TEST_789',
      batchStatus: 'SUCCESS',
      senderBatchId: 'sender_batch_123',
    });

    const arbitrator = new SynapseArbitrator(secret);

    const manager = new ContractManager({
      ordersManager,
      payoutsManager,
      arbitrator,
      hmacSecret: secret,
    });

    return { manager, ordersManager, payoutsManager, arbitrator };
  }

  const sampleWorker: Participant = {
    id: '423e4567-e89b-12d3-a456-426614174003',
    role: 'WORKER',
    name: 'DevAgent-Alpha',
    paypalAccount: 'devagent@developer.org',
  };

  const sampleContractInput: Omit<ContractSpec, 'id' | 'createdAt' | 'metadata'> = {
    buyer: {
      id: '223e4567-e89b-12d3-a456-426614174001',
      role: 'BUYER',
      name: 'Autonomous ProcureBot',
      paypalAccount: 'buyer@corp.com',
    },
    totalAmountInCents: 10000, // $100.00
    currency: 'USD',
    sla: {
      slaId: '323e4567-e89b-12d3-a456-426614174002',
      taskTitle: 'TypeScript Module Generation',
      taskDescription: 'Generate an SVG icon generator with schema conformance and valid hashes.',
      maxDeliverySeconds: 3600,
      maxArbitrationRetries: 1,
      minOverallScore: 80,
      partialReleaseThreshold: 60,
      deterministicChecks: [
        {
          id: 'check_hash',
          name: 'SHA-256 Code Hash Verification',
          type: 'HASH_EQUAL',
          targetField: 'icon-generator.ts',
          expectedValue: '', // dynamically filled
          weight: 1,
          required: true,
        },
      ],
      semanticRubrics: [
        {
          id: 'rubric_quality',
          name: 'Code Cleanliness & Documentation',
          description: 'Module must be typed and well documented.',
          weight: 1,
          minScore: 70,
          instructions: 'Check for export declarations, types, and descriptive comments.',
        },
      ],
    },
    milestones: [
      {
        sequence: 1,
        name: 'Full Deliverable Release',
        amountInCents: 10000,
        currency: 'USD',
        status: 'PENDING',
      },
    ],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };

  it('completes the full verified settlement lifecycle: draft -> lock -> accept -> submit -> payout_pending -> settled', async () => {
    const { manager, payoutsManager, arbitrator } = createTestSetup();

    const codeContent = 'export function renderSvg(name: string): string { return `<svg>${name}</svg>`; }';
    const codeHash = crypto.createHash('sha256').update(codeContent).digest('hex');

    const contractWithHash = {
      ...sampleContractInput,
      sla: {
        ...sampleContractInput.sla,
        deterministicChecks: [
          {
            ...sampleContractInput.sla.deterministicChecks[0]!,
            expectedValue: codeHash,
          },
        ],
      },
    };

    // 1. Create Contract
    const { contract, escrow, approvalUrl } = await manager.createContract(contractWithHash);
    expect(escrow.state).toBe(EscrowState.ESCROW_PENDING);
    expect(escrow.paypalOrderId).toBe('ORD_TEST_MOCK_123');
    expect(approvalUrl).toContain('paypal.com');

    // 2. Lock Escrow
    const lockedEscrow = manager.confirmEscrowLock(contract.id, 'AUTH_TEST_777');
    expect(lockedEscrow.state).toBe(EscrowState.ESCROW_LOCKED);
    expect(lockedEscrow.paypalAuthorizationId).toBe('AUTH_TEST_777');

    // 3. Worker accepts task
    const accepted = manager.acceptContract(contract.id, sampleWorker, sampleWorker.id);
    expect(accepted.escrow.state).toBe(EscrowState.IN_PROGRESS);
    expect(accepted.contract.worker?.name).toBe('DevAgent-Alpha');

    // 4. Worker submits deliverable
    const submission: SubmissionPayload = {
      contractId: contract.id,
      workerId: sampleWorker.id,
      milestoneSequence: 1,
      submittedAt: new Date().toISOString(),
      artifacts: [
        {
          name: 'icon-generator.ts',
          type: 'CODE',
          content: codeContent,
        },
      ],
    };

    const { verdict, escrow: pendingEscrow } = await manager.submitDeliverable(submission, sampleWorker.id);

    expect(verdict.decision).toBe('RELEASE');
    expect(verdict.payoutPercentage).toBe(1.0);
    // P0 Fix 5: State is PAYOUT_PENDING until PayPal confirms payout
    expect(pendingEscrow.state).toBe(EscrowState.PAYOUT_PENDING);
    expect(pendingEscrow.disbursedAmountInCents).toBe(10000);
    expect(payoutsManager.executeMilestonePayout).toHaveBeenCalled();

    // 5. PayPal webhook confirms payout completion -> transitions to SETTLED
    const settledEscrow = manager.confirmPayoutItemSuccess('BATCH_TEST_789');
    expect(settledEscrow.state).toBe(EscrowState.SETTLED);

    // 6. Verify verdict signature against trusted public key (P0 Fix 1)
    const isSignatureValid = SynapseArbitrator.verifyVerdictSignature(verdict, arbitrator.getPublicKey());
    expect(isSignatureValid).toBe(true);

    // 7. Verify agent reputation and audit checkpoint (P2 Differentiators)
    const reputation = manager.getAgentReputation(sampleWorker.id);
    expect(reputation.completedContracts).toBe(1);
    expect(reputation.reputationScore).toBeGreaterThanOrEqual(80);

    const checkpoint = manager.getSignedCheckpoint(contract.id);
    expect(checkpoint.rootHash).toBeDefined();
    expect(checkpoint.signature).toBeDefined();
  });

  it('runs multi-milestone progression across payout confirmations (Claim 1 & P0 Fix 5)', async () => {
    const { manager, ordersManager } = createTestSetup();

    const multiMilestoneSpec = {
      ...sampleContractInput,
      totalAmountInCents: 20000,
      sla: {
        ...sampleContractInput.sla,
        deterministicChecks: [
          {
            id: 'chk_regex',
            name: 'Regex Match',
            type: 'REGEX_MATCH' as const,
            targetField: 'artifact.ts',
            expectedValue: '^export function',
            weight: 1,
            required: true,
          },
        ],
      },
      milestones: [
        {
          sequence: 1,
          name: 'Phase 1: Architecture Core',
          amountInCents: 10000,
          currency: 'USD',
          status: 'PENDING' as const,
        },
        {
          sequence: 2,
          name: 'Phase 2: Final Implementation',
          amountInCents: 10000,
          currency: 'USD',
          status: 'PENDING' as const,
        },
      ],
    };

    const { contract } = await manager.createContract(multiMilestoneSpec);
    manager.confirmEscrowLock(contract.id, 'AUTH_MULTI_777');
    manager.acceptContract(contract.id, sampleWorker, sampleWorker.id);

    // Milestone 1 submission
    const subM1: SubmissionPayload = {
      contractId: contract.id,
      workerId: sampleWorker.id,
      milestoneSequence: 1,
      submittedAt: new Date().toISOString(),
      artifacts: [
        {
          name: 'artifact.ts',
          type: 'CODE',
          content: 'export function phase1() { return "core"; }',
        },
      ],
    };

    const resultM1 = await manager.submitDeliverable(subM1, sampleWorker.id);
    expect(resultM1.verdict.decision).toBe('RELEASE');
    expect(resultM1.escrow.state).toBe(EscrowState.PAYOUT_PENDING);

    // Confirm payout item for milestone 1 -> moves to IN_PROGRESS with activeMilestone = 2
    const escrowM1Settled = manager.confirmPayoutItemSuccess('BATCH_TEST_789');
    expect(escrowM1Settled.state).toBe(EscrowState.IN_PROGRESS);
    expect(escrowM1Settled.activeMilestone).toBe(2);

    // Milestone 2 submission
    const subM2: SubmissionPayload = {
      contractId: contract.id,
      workerId: sampleWorker.id,
      milestoneSequence: 2,
      submittedAt: new Date().toISOString(),
      artifacts: [
        {
          name: 'artifact.ts',
          type: 'CODE',
          content: 'export function phase2() { return "complete"; }',
        },
      ],
    };

    const resultM2 = await manager.submitDeliverable(subM2, sampleWorker.id);
    expect(resultM2.escrow.state).toBe(EscrowState.PAYOUT_PENDING);

    // Confirm payout item for final milestone 2 -> moves to SETTLED
    const escrowM2Settled = manager.confirmPayoutItemSuccess('BATCH_TEST_789');
    expect(escrowM2Settled.state).toBe(EscrowState.SETTLED);
    expect(escrowM2Settled.disbursedAmountInCents).toBe(20000);
  });

  it('halts settlement if missing PayPal authorization hold (P0 Fix 3)', async () => {
    const { manager } = createTestSetup();

    const { contract } = await manager.createContract({
      ...sampleContractInput,
      sla: {
        ...sampleContractInput.sla,
        deterministicChecks: [],
        semanticRubrics: [],
      },
    });

    // Worker accepts before escrow lock
    const escrow = (manager as any).escrows.get(contract.id);
    escrow.state = EscrowState.IN_PROGRESS;
    contract.worker = sampleWorker;

    const submission: SubmissionPayload = {
      contractId: contract.id,
      workerId: sampleWorker.id,
      milestoneSequence: 1,
      submittedAt: new Date().toISOString(),
      artifacts: [{ name: 'out.txt', type: 'CODE', content: 'test code' }],
    };

    // Settlement without authorization ID MUST halt immediately!
    await expect(manager.submitDeliverable(submission, sampleWorker.id)).rejects.toThrow(
      /Settlement halted: Missing PayPal authorization hold/
    );
  });

  it('supports contract negotiation flow (P1 Fix 14)', async () => {
    const { manager } = createTestSetup();

    const { contract } = await manager.createContract(sampleContractInput);

    // Worker proposes counter-terms
    const proposal = manager.proposeTerms(
      contract.id,
      {
        contractId: contract.id,
        proposerId: sampleWorker.id,
        proposedBy: 'WORKER',
        proposedAmountInCents: 15000, // Counter-offer $150.00
        proposedDeliverySeconds: 7200,
        notes: 'Scope requires additional integration testing time',
      },
      sampleWorker.id
    );

    expect(proposal.id).toBeDefined();
    expect(proposal.status).toBe('PROPOSED');

    const status = manager.getContract(contract.id);
    expect(status.escrow.state).toBe(EscrowState.NEGOTIATING);

    // Buyer accepts terms
    const accepted = manager.acceptTerms(contract.id, proposal.id, sampleContractInput.buyer.id);
    expect(accepted.contract.totalAmountInCents).toBe(15000);
    expect(accepted.contract.sla.maxDeliverySeconds).toBe(7200);
    expect(accepted.escrow.state).toBe(EscrowState.DRAFT);
  });

  it('triggers remediation on failure and voids/refunds on exhaustion', async () => {
    const { manager } = createTestSetup();

    const expectedHash = 'a'.repeat(64);
    const contractWithStrictHash = {
      ...sampleContractInput,
      sla: {
        ...sampleContractInput.sla,
        deterministicChecks: [
          {
            ...sampleContractInput.sla.deterministicChecks[0]!,
            expectedValue: expectedHash,
          },
        ],
      },
    };

    const { contract } = await manager.createContract(contractWithStrictHash);
    manager.confirmEscrowLock(contract.id, 'AUTH_MOCK_1');
    manager.acceptContract(contract.id, sampleWorker, sampleWorker.id);

    const badSubmission: SubmissionPayload = {
      contractId: contract.id,
      workerId: sampleWorker.id,
      milestoneSequence: 1,
      submittedAt: new Date().toISOString(),
      artifacts: [
        {
          name: 'icon-generator.ts',
          type: 'CODE',
          content: 'broken code with wrong hash',
        },
      ],
    };

    const attempt1 = await manager.submitDeliverable(badSubmission, sampleWorker.id);
    expect(attempt1.verdict.decision).toBe('REJECT');
    expect(attempt1.verdict.canRetry).toBe(true);
    expect(attempt1.escrow.state).toBe(EscrowState.REMEDIATION_REQUIRED);

    const attempt2 = await manager.submitDeliverable(badSubmission, sampleWorker.id);
    expect(attempt2.verdict.decision).toBe('REJECT');
    expect(attempt2.verdict.canRetry).toBe(false);
    expect(attempt2.escrow.state).toBe(EscrowState.VOIDED);
    expect(attempt2.escrow.refundedAmountInCents).toBe(10000);
  });
});
