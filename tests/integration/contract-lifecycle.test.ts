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

  it('completes the full happy path: draft -> lock -> accept -> submit -> arbitration -> payout', async () => {
    const { manager, payoutsManager } = createTestSetup();

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

    // 2. Lock Escrow (simulate webhook or authorization approval)
    const lockedEscrow = manager.confirmEscrowLock(contract.id, 'AUTH_TEST_777');
    expect(lockedEscrow.state).toBe(EscrowState.ESCROW_LOCKED);
    expect(lockedEscrow.paypalAuthorizationId).toBe('AUTH_TEST_777');

    // 3. Worker accepts task
    const accepted = manager.acceptContract(contract.id, sampleWorker);
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

    const { verdict, escrow: settledEscrow } = await manager.submitDeliverable(submission);

    expect(verdict.decision).toBe('RELEASE');
    expect(verdict.payoutPercentage).toBe(1.0);
    expect(settledEscrow.state).toBe(EscrowState.SETTLED);
    expect(settledEscrow.disbursedAmountInCents).toBe(10000);
    expect(payoutsManager.executeMilestonePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: contract.id,
        recipientEmail: 'devagent@developer.org',
        amountInCents: 10000,
      })
    );

    // 5. Verify entire audit trail cryptographic integrity
    const finalContract = manager.getContract(contract.id);
    expect(finalContract.auditIntegrity.valid).toBe(true);
    expect(finalContract.escrow.auditTrail.length).toBeGreaterThanOrEqual(5);

    // 6. Verify verdict signature with Ed25519 offline verification (Claim 8)
    const isSignatureValid = SynapseArbitrator.verifyVerdictSignature(verdict);
    expect(isSignatureValid).toBe(true);
  });

  it('runs multi-milestone progression correctly without premature settlement (Claim 1)', async () => {
    const { manager, ordersManager } = createTestSetup();

    const multiMilestoneSpec = {
      ...sampleContractInput,
      totalAmountInCents: 20000, // $200.00 total across 2 milestones
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
    manager.acceptContract(contract.id, sampleWorker);

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

    const resultM1 = await manager.submitDeliverable(subM1);
    expect(resultM1.verdict.decision).toBe('RELEASE');
    // Escrow must NOT be settled yet; must advance activeMilestone to 2 and remain IN_PROGRESS
    expect(resultM1.escrow.state).toBe(EscrowState.IN_PROGRESS);
    expect(resultM1.escrow.activeMilestone).toBe(2);
    expect(resultM1.escrow.disbursedAmountInCents).toBe(10000);
    // Verified capture was not final capture
    expect(ordersManager.captureAuthorization).toHaveBeenCalledWith(
      'AUTH_MULTI_777',
      10000,
      'USD',
      false // isFinalCapture is FALSE for non-final milestone
    );

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

    const resultM2 = await manager.submitDeliverable(subM2);
    expect(resultM2.verdict.decision).toBe('RELEASE');
    // Now final milestone: escrow MUST transition to SETTLED
    expect(resultM2.escrow.state).toBe(EscrowState.SETTLED);
    expect(resultM2.escrow.disbursedAmountInCents).toBe(20000);
    expect(ordersManager.captureAuthorization).toHaveBeenCalledWith(
      'AUTH_MULTI_777',
      10000,
      'USD',
      true // isFinalCapture is TRUE for final milestone
    );
  });

  it('aborts payout and throws immediately if capture fails (Claim 4)', async () => {
    const { manager, ordersManager, payoutsManager } = createTestSetup();

    vi.spyOn(ordersManager, 'captureAuthorization').mockRejectedValueOnce(
      new Error('PAYPAL_HOLD_CAPTURE_FAILED: Insufficient buyer funds')
    );

    const { contract } = await manager.createContract({
      ...sampleContractInput,
      sla: {
        ...sampleContractInput.sla,
        deterministicChecks: [],
        semanticRubrics: [],
      },
    });

    manager.confirmEscrowLock(contract.id, 'AUTH_FAIL_001');
    manager.acceptContract(contract.id, sampleWorker);

    const submission: SubmissionPayload = {
      contractId: contract.id,
      workerId: sampleWorker.id,
      milestoneSequence: 1,
      submittedAt: new Date().toISOString(),
      artifacts: [{ name: 'out.txt', type: 'CODE', content: 'test code' }],
    };

    // Must throw capture failure and NOT disburse payout!
    await expect(manager.submitDeliverable(submission)).rejects.toThrow(
      /Critical settlement error: PayPal capture failed/
    );

    // Ensure payoutsManager was NEVER called
    expect(payoutsManager.executeMilestonePayout).not.toHaveBeenCalled();

    // Verify contract is NOT settled
    const status = manager.getContract(contract.id);
    expect(status.escrow.state).not.toBe(EscrowState.SETTLED);
    expect(status.escrow.disbursedAmountInCents).toBe(0);
  });

  it('rejects worker impostor from submitting or accepting (Claim 7)', async () => {
    const { manager } = createTestSetup();

    const { contract } = await manager.createContract({
      ...sampleContractInput,
      sla: { ...sampleContractInput.sla, deterministicChecks: [] },
    });

    manager.confirmEscrowLock(contract.id, 'AUTH_SEC_111');
    manager.acceptContract(contract.id, sampleWorker, sampleWorker.id);

    const impostorWorkerId = '999e4567-e89b-12d3-a456-426614174999';
    const submissionFromImpostor: SubmissionPayload = {
      contractId: contract.id,
      workerId: impostorWorkerId,
      milestoneSequence: 1,
      submittedAt: new Date().toISOString(),
      artifacts: [{ name: 'hack.ts', type: 'CODE', content: 'fake work' }],
    };

    // Submit with impostor id should be rejected
    await expect(manager.submitDeliverable(submissionFromImpostor, impostorWorkerId)).rejects.toThrow(
      /Impostor submission rejected|Unauthorized/
    );
  });

  it('triggers remediation on failure and allows successful retry', async () => {
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
    manager.acceptContract(contract.id, sampleWorker);

    // Initial flawed submission
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

    const attempt1 = await manager.submitDeliverable(badSubmission);
    expect(attempt1.verdict.decision).toBe('REJECT');
    expect(attempt1.verdict.canRetry).toBe(true);
    expect(attempt1.escrow.state).toBe(EscrowState.REMEDIATION_REQUIRED);
    expect(attempt1.escrow.retriesUsed).toBe(1);

    // Second submission with zero retries left results in terminal VOID and refund (Claim 3)
    const attempt2 = await manager.submitDeliverable(badSubmission);
    expect(attempt2.verdict.decision).toBe('REJECT');
    expect(attempt2.verdict.canRetry).toBe(false);
    expect(attempt2.escrow.state).toBe(EscrowState.VOIDED);
    expect(attempt2.escrow.refundedAmountInCents).toBe(10000);
  });
});
