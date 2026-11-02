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

    // Mock PayPal network boundaries for pure integration testing
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

    return { manager, ordersManager, payoutsManager };
  }

  const sampleContract: ContractSpec = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    buyer: {
      id: '223e4567-e89b-12d3-a456-426614174001',
      role: 'BUYER',
      name: 'Autonomous ProcureBot',
      paypalAccount: 'buyer@corp.com',
    },
    totalAmount: 100,
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
        percentage: 100,
        amount: 100,
        currency: 'USD',
        status: 'PENDING',
      },
    ],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    metadata: {},
  };

  const sampleWorker: Participant = {
    id: '423e4567-e89b-12d3-a456-426614174003',
    role: 'WORKER',
    name: 'DevAgent-Alpha',
    paypalAccount: 'devagent@developer.org',
  };

  it('completes the full happy path: draft -> lock -> accept -> submit -> arbitration -> payout', async () => {
    const { manager, payoutsManager } = createTestSetup();

    const codeContent = 'export function renderSvg(name: string): string { return `<svg>${name}</svg>`; }';
    const codeHash = crypto.createHash('sha256').update(codeContent).digest('hex');

    const contractWithHash = {
      ...sampleContract,
      sla: {
        ...sampleContract.sla,
        deterministicChecks: [
          {
            ...sampleContract.sla.deterministicChecks[0]!,
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
    expect(settledEscrow.disbursedAmount).toBe(100);
    expect(payoutsManager.executeMilestonePayout).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: contract.id,
        recipientEmail: 'devagent@developer.org',
        amount: 100,
      })
    );

    // 5. Verify entire audit trail cryptographic integrity
    const finalContract = manager.getContract(contract.id);
    expect(finalContract.auditIntegrity.valid).toBe(true);
    expect(finalContract.escrow.auditTrail.length).toBeGreaterThanOrEqual(5);
  });

  it('triggers remediation on failure and allows successful retry', async () => {
    const { manager } = createTestSetup();

    const expectedHash = 'a'.repeat(64);
    const contractWithStrictHash = {
      ...sampleContract,
      id: '523e4567-e89b-12d3-a456-426614174005',
      sla: {
        ...sampleContract.sla,
        deterministicChecks: [
          {
            ...sampleContract.sla.deterministicChecks[0]!,
            expectedValue: expectedHash,
          },
        ],
      },
    };

    await manager.createContract(contractWithStrictHash);
    manager.confirmEscrowLock(contractWithStrictHash.id, 'AUTH_MOCK_1');
    manager.acceptContract(contractWithStrictHash.id, sampleWorker);

    // Initial flawed submission
    const badSubmission: SubmissionPayload = {
      contractId: contractWithStrictHash.id,
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

    // Second submission with zero retries left results in terminal VOID
    const attempt2 = await manager.submitDeliverable(badSubmission);
    expect(attempt2.verdict.decision).toBe('REJECT');
    expect(attempt2.verdict.canRetry).toBe(false);
    expect(attempt2.escrow.state).toBe(EscrowState.VOIDED);
    expect(attempt2.escrow.refundedAmount).toBe(100);
  });
});
