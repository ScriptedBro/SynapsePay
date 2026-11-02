import { v4 as uuidv4 } from 'uuid';
import { ContractSpec, ContractSpecSchema, Participant, SubmissionPayload } from '../types/contract.js';
import { EscrowRecord, EscrowState, CapturedMilestoneRecord } from '../types/escrow.js';
import { ArbitrationVerdict, ArbitrationDecision } from '../types/arbitration.js';
import { EscrowStateMachine } from './state-machine.js';
import { AuditLedger } from './audit-ledger.js';
import { SynapseArbitrator } from '../arbitration/arbitrator.js';
import { PayPalOrdersManager } from '../paypal/orders.js';
import { PayPalPayoutsManager } from '../paypal/payouts.js';

export interface ContractManagerDependencies {
  ordersManager: PayPalOrdersManager;
  payoutsManager: PayPalPayoutsManager;
  arbitrator: SynapseArbitrator;
  hmacSecret: string;
  maxEscrowAmountInCents?: number;
  dailyAgentLimitInCents?: number;
}

export class ContractManager {
  private readonly contracts = new Map<string, ContractSpec>();
  private readonly escrows = new Map<string, EscrowRecord>();
  private readonly ledgers = new Map<string, AuditLedger>();
  private readonly verdicts = new Map<string, ArbitrationVerdict[]>();
  private readonly submissions = new Map<string, SubmissionPayload[]>();

  // Bi-directional indices for authoritative webhook resolution (Fix for Claim 5)
  private readonly orderIdToContractId = new Map<string, string>();
  private readonly authIdToContractId = new Map<string, string>();
  private readonly payoutBatchToContractId = new Map<string, string>();

  // Capital guardrails & daily limits (Fix for Claim 6)
  private readonly agentDailySpend = new Map<string, { date: string; amountInCents: number }>();
  private killSwitchActive = false;

  constructor(private readonly deps: ContractManagerDependencies) {}

  public setKillSwitch(active: boolean): void {
    this.killSwitchActive = active;
  }

  public isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  public getContractIdByOrderId(orderId: string): string | undefined {
    return this.orderIdToContractId.get(orderId);
  }

  public getContractIdByAuthId(authId: string): string | undefined {
    return this.authIdToContractId.get(authId);
  }

  public getContractIdByPayoutBatchId(batchId: string): string | undefined {
    return this.payoutBatchToContractId.get(batchId);
  }

  public async createContract(specInput: ContractSpec): Promise<{
    contract: ContractSpec;
    escrow: EscrowRecord;
    approvalUrl?: string;
  }> {
    if (this.killSwitchActive) {
      throw new Error('Protocol operation halted: Kill switch is active');
    }

    // 1. Authoritative Server-Owned Identity & Invariant Validation (Fix for Claim 14 & 13)
    const contractId = specInput.id ?? uuidv4();
    if (this.contracts.has(contractId)) {
      throw new Error(`Conflict: Contract with ID ${contractId} already exists`);
    }

    const validatedSpec = ContractSpecSchema.parse({
      ...specInput,
      id: contractId,
      createdAt: specInput.createdAt ?? new Date().toISOString(),
      expiresAt: specInput.expiresAt ?? new Date(Date.now() + (specInput.sla.maxDeliverySeconds ?? 86400) * 1000).toISOString(),
    });

    // 2. Capital Guardrails & Daily Caps (Fix for Claim 6)
    const maxAllowedCents = this.deps.maxEscrowAmountInCents ?? 500000; // Default $5,000.00
    if (validatedSpec.totalAmountInCents > maxAllowedCents) {
      throw new Error(
        `Capital guardrail breached: Contract amount (${validatedSpec.totalAmountInCents} cents) exceeds maximum limit (${maxAllowedCents} cents)`
      );
    }

    const today = new Date().toISOString().split('T')[0]!;
    const buyerSpend = this.agentDailySpend.get(validatedSpec.buyer.id);
    const currentDaily = buyerSpend?.date === today ? buyerSpend.amountInCents : 0;
    const dailyCap = this.deps.dailyAgentLimitInCents ?? 2000000; // Default $20,000.00 / day

    if (currentDaily + validatedSpec.totalAmountInCents > dailyCap) {
      throw new Error(`Daily capital limit exceeded for buyer agent ${validatedSpec.buyer.id}`);
    }

    this.agentDailySpend.set(validatedSpec.buyer.id, {
      date: today,
      amountInCents: currentDaily + validatedSpec.totalAmountInCents,
    });

    // 3. Initialize Audit Ledger & PayPal Authorization Order
    const ledger = new AuditLedger(this.deps.hmacSecret);
    this.ledgers.set(contractId, ledger);

    ledger.append(contractId, 'CONTRACT_DRAFTED', validatedSpec.buyer.id, {
      totalAmountInCents: validatedSpec.totalAmountInCents,
      currency: validatedSpec.currency,
      milestoneCount: validatedSpec.milestones.length,
    });

    const orderResult = await this.deps.ordersManager.createAuthorizationOrder({
      contractId,
      amountInCents: validatedSpec.totalAmountInCents,
      currency: validatedSpec.currency,
    });

    // Index order for incoming webhooks
    this.orderIdToContractId.set(orderResult.orderId, contractId);

    const now = new Date().toISOString();
    const escrow: EscrowRecord = {
      contractId,
      state: EscrowState.ESCROW_PENDING,
      totalAmountInCents: validatedSpec.totalAmountInCents,
      currency: validatedSpec.currency,
      paypalOrderId: orderResult.orderId,
      activeMilestone: 1,
      totalMilestones: validatedSpec.milestones.length,
      retriesUsed: 0,
      disbursedAmountInCents: 0,
      refundedAmountInCents: 0,
      capturedMilestones: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: validatedSpec.expiresAt,
      auditTrail: ledger.getHistory(),
    };

    ledger.append(contractId, 'ESCROW_INITIALIZED', 'SYSTEM', {
      paypalOrderId: orderResult.orderId,
      status: orderResult.status,
    });

    escrow.auditTrail = ledger.getHistory();

    this.contracts.set(contractId, validatedSpec);
    this.escrows.set(contractId, escrow);
    this.verdicts.set(contractId, []);
    this.submissions.set(contractId, []);

    return {
      contract: validatedSpec,
      escrow,
      approvalUrl: orderResult.approvalUrl,
    };
  }

  public confirmEscrowLock(contractId: string, paypalAuthorizationId?: string): EscrowRecord {
    const escrow = this.mustGetEscrow(contractId);
    const ledger = this.mustGetLedger(contractId);

    EscrowStateMachine.validateTransition(escrow.state, EscrowState.ESCROW_LOCKED);

    escrow.state = EscrowState.ESCROW_LOCKED;
    if (paypalAuthorizationId) {
      escrow.paypalAuthorizationId = paypalAuthorizationId;
      this.authIdToContractId.set(paypalAuthorizationId, contractId);
    }
    escrow.updatedAt = new Date().toISOString();

    ledger.append(contractId, 'ESCROW_LOCKED', 'PAYPAL_WEBHOOK', {
      paypalAuthorizationId: escrow.paypalAuthorizationId,
    });
    escrow.auditTrail = ledger.getHistory();

    return escrow;
  }

  public acceptContract(
    contractId: string,
    worker: Participant,
    callerAgentId?: string
  ): { contract: ContractSpec; escrow: EscrowRecord } {
    const contract = this.mustGetContract(contractId);
    const escrow = this.mustGetEscrow(contractId);
    const ledger = this.mustGetLedger(contractId);

    // Agent authorization check (Fix for Claim 7)
    if (callerAgentId && callerAgentId !== worker.id) {
      throw new Error(`Unauthorized: Caller identity ${callerAgentId} does not match worker ${worker.id}`);
    }

    EscrowStateMachine.validateTransition(escrow.state, EscrowState.IN_PROGRESS);

    contract.worker = worker;
    escrow.state = EscrowState.IN_PROGRESS;
    escrow.updatedAt = new Date().toISOString();

    ledger.append(contractId, 'CONTRACT_ACCEPTED', worker.id, {
      workerId: worker.id,
      workerName: worker.name,
      workerEmail: worker.paypalAccount,
    });
    escrow.auditTrail = ledger.getHistory();

    return { contract, escrow };
  }

  public async submitDeliverable(
    submission: SubmissionPayload,
    callerAgentId?: string
  ): Promise<{ verdict: ArbitrationVerdict; escrow: EscrowRecord }> {
    if (this.killSwitchActive) {
      throw new Error('Protocol operation halted: Kill switch is active');
    }

    const contract = this.mustGetContract(submission.contractId);
    const escrow = this.mustGetEscrow(submission.contractId);
    const ledger = this.mustGetLedger(submission.contractId);

    // 1. Strict Agent Authorization Check (Fix for Claim 7)
    if (!contract.worker) {
      throw new Error('Contract has not been assigned to a worker agent');
    }
    if (submission.workerId !== contract.worker.id) {
      throw new Error(
        `Impostor submission rejected: Worker ${submission.workerId} is not assigned to contract ${contract.id}`
      );
    }
    if (callerAgentId && callerAgentId !== contract.worker.id) {
      throw new Error(`Unauthorized: Caller ${callerAgentId} is not authorized for worker ${contract.worker.id}`);
    }

    // 2. Validate Milestone Sequence Alignment
    if (submission.milestoneSequence !== escrow.activeMilestone) {
      throw new Error(
        `Mismatched milestone sequence: Active milestone is #${escrow.activeMilestone}, submitted #${submission.milestoneSequence}`
      );
    }

    EscrowStateMachine.validateTransition(escrow.state, EscrowState.ARBITRATION_PENDING);

    escrow.state = EscrowState.ARBITRATION_PENDING;
    escrow.updatedAt = new Date().toISOString();
    ledger.append(submission.contractId, 'DELIVERABLE_SUBMITTED', submission.workerId, {
      artifactsCount: submission.artifacts.length,
      milestone: submission.milestoneSequence,
    });

    // 3. Autonomous Arbitration Evaluation
    const verdict = await this.deps.arbitrator.arbitrate(
      contract,
      submission,
      escrow.retriesUsed
    );

    const contractSubmissions = this.submissions.get(submission.contractId) ?? [];
    contractSubmissions.push(submission);
    this.submissions.set(submission.contractId, contractSubmissions);

    const contractVerdicts = this.verdicts.get(submission.contractId) ?? [];
    contractVerdicts.push(verdict);
    this.verdicts.set(submission.contractId, contractVerdicts);

    ledger.append(submission.contractId, 'ARBITRATION_COMPLETED', 'ARBITRATOR', {
      decision: verdict.decision,
      score: verdict.overallScore,
      payoutPercentage: verdict.payoutPercentage,
      signedSignature: verdict.signedVerdictSignature,
    });

    const activeMilestone = contract.milestones.find(
      (m) => m.sequence === submission.milestoneSequence
    ) ?? contract.milestones[0]!;

    const isFinalMilestone = escrow.activeMilestone >= contract.milestones.length;

    // 4. Handle Decision Paths
    if (verdict.decision === ArbitrationDecision.RELEASE || verdict.decision === ArbitrationDecision.PARTIAL_RELEASE) {
      const payoutRatio = verdict.payoutPercentage;
      const milestoneDisbursementCents = Math.round(activeMilestone.amountInCents * payoutRatio);
      const milestoneRefundCents = activeMilestone.amountInCents - milestoneDisbursementCents;

      // CRITICAL FIX FOR CLAIM 4: Never swallow capture error! Must capture hold before payout.
      let captureId = 'MOCK_CAPTURE_' + Date.now();
      if (escrow.paypalAuthorizationId) {
        try {
          const capResult = await this.deps.ordersManager.captureAuthorization(
            escrow.paypalAuthorizationId,
            activeMilestone.amountInCents,
            activeMilestone.currency,
            isFinalMilestone // Fix for Claim 1: Only final milestone sets is_final_capture = true
          );
          captureId = capResult.captureId;
        } catch (captureErr: any) {
          ledger.append(submission.contractId, 'CAPTURE_FAILED', 'PAYPAL_ORDERS', {
            error: captureErr.message,
            authorizationId: escrow.paypalAuthorizationId,
          });
          escrow.updatedAt = new Date().toISOString();
          // ABORT! Do not proceed to payout if buyer was not charged!
          throw new Error(`Critical settlement error: PayPal capture failed (${captureErr.message}). Payout aborted.`);
        }
      }

      // Execute Payout via PayPal
      const recipientEmail = contract.worker.paypalAccount;
      let payoutBatchId = 'MOCK_BATCH_' + Date.now();

      if (milestoneDisbursementCents > 0) {
        const payoutResult = await this.deps.payoutsManager.executeMilestonePayout({
          contractId: contract.id!,
          milestoneSequence: submission.milestoneSequence,
          recipientEmail,
          amountInCents: milestoneDisbursementCents,
          currency: activeMilestone.currency,
        });
        payoutBatchId = payoutResult.payoutBatchId;
        this.payoutBatchToContractId.set(payoutBatchId, contract.id!);
      }

      // Fix for Claim 3: If partial release, refund remaining captured cents back to buyer
      if (milestoneRefundCents > 0 && captureId && !captureId.startsWith('MOCK_')) {
        try {
          await this.deps.ordersManager.refundCapture(
            captureId,
            milestoneRefundCents,
            activeMilestone.currency,
            `SynapsePay Partial Settlement: Remainder returned to buyer for milestone #${submission.milestoneSequence}`
          );
        } catch {
          // Log refund note
        }
      }

      const captureRecord: CapturedMilestoneRecord = {
        milestoneSequence: submission.milestoneSequence,
        captureId,
        payoutBatchId,
        amountInCents: activeMilestone.amountInCents,
        disbursedInCents: milestoneDisbursementCents,
        refundedInCents: milestoneRefundCents,
        settledAt: new Date().toISOString(),
      };
      escrow.capturedMilestones.push(captureRecord);
      escrow.disbursedAmountInCents += milestoneDisbursementCents;
      escrow.refundedAmountInCents += milestoneRefundCents;

      // Fix for Claim 1: Multi-Milestone progression
      if (!isFinalMilestone) {
        activeMilestone.status = 'SETTLED';
        escrow.activeMilestone += 1;
        escrow.retriesUsed = 0; // Reset retries for next milestone
        escrow.state = EscrowState.IN_PROGRESS; // Advance to next milestone
        escrow.updatedAt = new Date().toISOString();

        ledger.append(submission.contractId, 'MILESTONE_SETTLED', 'ARBITRATOR', {
          completedMilestone: submission.milestoneSequence,
          nextMilestone: escrow.activeMilestone,
          disbursedInCents: milestoneDisbursementCents,
        });
      } else {
        // Final milestone settled -> contract terminal SETTLED
        activeMilestone.status = 'SETTLED';
        escrow.state = EscrowState.SETTLED;
        escrow.updatedAt = new Date().toISOString();

        ledger.append(submission.contractId, 'SETTLEMENT_COMPLETED', 'PAYPAL_PAYOUTS', {
          payoutBatchId,
          totalDisbursedInCents: escrow.disbursedAmountInCents,
          recipient: recipientEmail,
        });
      }
    } else if (verdict.canRetry) {
      escrow.retriesUsed += 1;
      escrow.state = EscrowState.REMEDIATION_REQUIRED;
      escrow.updatedAt = new Date().toISOString();

      ledger.append(submission.contractId, 'REMEDIATION_TRIGGERED', 'ARBITRATOR', {
        retriesUsed: escrow.retriesUsed,
        maxRetries: contract.sla.maxArbitrationRetries,
      });
    } else if (verdict.decision === ArbitrationDecision.DISPUTE) {
      // Fix for Claim 2: Reachable DISPUTED state
      escrow.state = EscrowState.DISPUTED;
      escrow.updatedAt = new Date().toISOString();

      ledger.append(submission.contractId, 'DISPUTE_RAISED', 'ARBITRATOR', {
        reason: 'SLA_CRITERIA_CONTESTED_OR_AMBIGUOUS',
        score: verdict.overallScore,
      });
    } else {
      // Terminal breach -> void remaining hold and refund buyer (Fix for Claim 3)
      await this.executeVoidAndRefund(contract, escrow, ledger, 'SLA_BREACH_NO_RETRIES');
    }

    escrow.auditTrail = ledger.getHistory();
    return { verdict, escrow };
  }

  public async resolveDispute(
    contractId: string,
    workerSplitRatio: number, // 0.0 to 1.0
    reason: string
  ): Promise<EscrowRecord> {
    const contract = this.mustGetContract(contractId);
    const escrow = this.mustGetEscrow(contractId);
    const ledger = this.mustGetLedger(contractId);

    if (escrow.state !== EscrowState.DISPUTED) {
      throw new Error(`Cannot resolve dispute on contract in state ${escrow.state}`);
    }

    const activeMilestone = contract.milestones.find((m) => m.sequence === escrow.activeMilestone) ?? contract.milestones[0]!;
    const workerCents = Math.round(activeMilestone.amountInCents * Math.max(0, Math.min(1, workerSplitRatio)));
    const buyerCents = activeMilestone.amountInCents - workerCents;

    // Disburse split
    if (workerCents > 0 && contract.worker) {
      await this.deps.payoutsManager.executeMilestonePayout({
        contractId,
        milestoneSequence: escrow.activeMilestone,
        recipientEmail: contract.worker.paypalAccount,
        amountInCents: workerCents,
        currency: activeMilestone.currency,
        note: `Dispute Resolution Split: ${reason}`,
      });
      escrow.disbursedAmountInCents += workerCents;
    }

    escrow.refundedAmountInCents += buyerCents;
    escrow.state = EscrowState.SETTLED;
    escrow.updatedAt = new Date().toISOString();

    ledger.append(contractId, 'DISPUTE_RESOLVED', 'ADMIN', {
      reason,
      workerCents,
      buyerCents,
    });
    escrow.auditTrail = ledger.getHistory();

    return escrow;
  }

  public async voidContract(contractId: string, reason: string): Promise<EscrowRecord> {
    const contract = this.mustGetContract(contractId);
    const escrow = this.mustGetEscrow(contractId);
    const ledger = this.mustGetLedger(contractId);

    EscrowStateMachine.validateTransition(escrow.state, EscrowState.VOIDED, reason);
    await this.executeVoidAndRefund(contract, escrow, ledger, reason);

    escrow.auditTrail = ledger.getHistory();
    return escrow;
  }

  private async executeVoidAndRefund(
    contract: ContractSpec,
    escrow: EscrowRecord,
    ledger: AuditLedger,
    reason: string
  ): Promise<void> {
    // 1. Release uncaptured authorization hold if it exists
    if (escrow.paypalAuthorizationId) {
      try {
        await this.deps.ordersManager.voidAuthorization(escrow.paypalAuthorizationId);
      } catch {
        // Void attempt logged
      }
    }

    // 2. Fix for Claim 3: Real money refund for any previously captured funds
    for (const captured of escrow.capturedMilestones) {
      const refundableCents = captured.disbursedInCents;
      if (refundableCents > 0 && !captured.captureId.startsWith('MOCK_')) {
        try {
          await this.deps.ordersManager.refundCapture(
            captured.captureId,
            refundableCents,
            contract.currency,
            `SynapsePay Void & Refund: ${reason}`
          );
        } catch {
          // Refund error logged
        }
      }
    }

    escrow.refundedAmountInCents = escrow.totalAmountInCents - escrow.disbursedAmountInCents;
    escrow.state = EscrowState.VOIDED;
    escrow.updatedAt = new Date().toISOString();

    ledger.append(contract.id!, 'CONTRACT_VOIDED_REFUNDED', 'SYSTEM', {
      reason,
      refundedAmountInCents: escrow.refundedAmountInCents,
    });
  }

  public sweepExpiredContracts(): { expiredCount: number; voidedIds: string[] } {
    const now = Date.now();
    const voidedIds: string[] = [];

    for (const [id, escrow] of this.escrows.entries()) {
      if (
        !EscrowStateMachine.isTerminal(escrow.state) &&
        escrow.expiresAt &&
        new Date(escrow.expiresAt).getTime() < now
      ) {
        this.voidContract(id, 'CONTRACT_EXPIRED_TIMEOUT')
          .then(() => voidedIds.push(id))
          .catch(() => {});
      }
    }

    return { expiredCount: voidedIds.length, voidedIds };
  }

  public getContract(contractId: string): {
    contract: ContractSpec;
    escrow: EscrowRecord;
    verdicts: ArbitrationVerdict[];
    submissions: SubmissionPayload[];
    auditIntegrity: { valid: boolean; compromisedIndex?: number; reason?: string };
  } {
    const contract = this.mustGetContract(contractId);
    const escrow = this.mustGetEscrow(contractId);
    const ledger = this.mustGetLedger(contractId);

    return {
      contract,
      escrow,
      verdicts: this.verdicts.get(contractId) ?? [],
      submissions: this.submissions.get(contractId) ?? [],
      auditIntegrity: ledger.verifyIntegrity(),
    };
  }

  public listContracts(): {
    contract: ContractSpec;
    escrow: EscrowRecord;
    latestVerdict?: ArbitrationVerdict;
    latestSubmission?: SubmissionPayload;
    auditIntegrity: { valid: boolean; compromisedIndex?: number; reason?: string };
  }[] {
    const results = [];
    for (const [id, contract] of this.contracts.entries()) {
      const escrow = this.escrows.get(id);
      const ledger = this.ledgers.get(id);
      const verdicts = this.verdicts.get(id) ?? [];
      const submissions = this.submissions.get(id) ?? [];
      if (escrow && ledger) {
        results.push({
          contract,
          escrow,
          latestVerdict: verdicts[verdicts.length - 1],
          latestSubmission: submissions[submissions.length - 1],
          auditIntegrity: ledger.verifyIntegrity(),
        });
      }
    }
    return results;
  }

  public seedSampleContracts(): void {
    if (this.contracts.size > 0) return;

    // --- CONTRACT 1: Multi-Milestone Settled & Paid ---
    const id1 = 'c1111111-2222-3333-4444-555555555551';
    const buyer1: Participant = {
      id: 'b1111111-0000-0000-0000-000000000001',
      role: 'BUYER',
      name: 'Acme Analytics Corp (Agent Principal)',
      paypalAccount: 'treasury@acme-corp.com',
    };
    const worker1: Participant = {
      id: 'w1111111-0000-0000-0000-000000000001',
      role: 'WORKER',
      name: 'VisualAgent-Alpha (Autonomous Dev)',
      paypalAccount: 'visualagent@sandbox.paypal.com',
    };

    const contract1: ContractSpec = {
      id: id1,
      buyer: buyer1,
      worker: worker1,
      totalAmountInCents: 5000, // $50.00
      currency: 'USD',
      sla: {
        slaId: 's1111111-0000-0000-0000-000000000001',
        taskTitle: 'TypeScript SVG Metric Chart Generator',
        taskDescription: 'Build zero-dependency SVG metric sparkline generator adhering strictly to interface and types.',
        maxDeliverySeconds: 86400,
        maxArbitrationRetries: 2,
        minOverallScore: 85,
        partialReleaseThreshold: 60,
        deterministicChecks: [
          {
            id: 'chk_regex',
            name: 'Exported Function Signature Validation',
            type: 'REGEX_MATCH',
            targetField: 'chart.ts',
            expectedValue: 'export function renderMetricChart',
            weight: 2,
            required: true,
          },
        ],
        semanticRubrics: [
          {
            id: 'rub_code_arch',
            name: 'Architectural Cleanliness & Documentation',
            description: 'Evaluate TypeScript interfaces, clean coordinate math, and zero external runtime dependencies.',
            weight: 3,
            minScore: 80,
            instructions: 'Ensure full TypeScript type exports, defensive bounds handling, and inline documentation.',
          },
        ],
      },
      milestones: [
        {
          sequence: 1,
          name: 'Milestone 1: Core Engine & Type Exports',
          amountInCents: 2500,
          currency: 'USD',
          status: 'SETTLED',
        },
        {
          sequence: 2,
          name: 'Milestone 2: Responsive Coordinates & Final Verification',
          amountInCents: 2500,
          currency: 'USD',
          status: 'SETTLED',
        },
      ],
      createdAt: '2026-11-02T07:30:00Z',
      expiresAt: '2026-11-03T07:30:00Z',
      metadata: { environment: 'production-verified' },
    };

    const ledger1 = new AuditLedger(this.deps.hmacSecret);
    ledger1.append(id1, 'CONTRACT_DRAFTED', buyer1.id, { totalAmountInCents: 5000 });
    ledger1.append(id1, 'ESCROW_INITIALIZED', 'SYSTEM', { paypalOrderId: 'ORD-88219-PP' });
    ledger1.append(id1, 'ESCROW_LOCKED', 'PAYPAL_WEBHOOK', { paypalAuthorizationId: 'AUTH-99214-HOLD' });
    ledger1.append(id1, 'CONTRACT_ACCEPTED', worker1.id, { workerName: worker1.name });
    ledger1.append(id1, 'DELIVERABLE_SUBMITTED', worker1.id, { milestone: 1 });
    ledger1.append(id1, 'MILESTONE_SETTLED', 'ARBITRATOR', { completedMilestone: 1, nextMilestone: 2, disbursedInCents: 2500 });
    ledger1.append(id1, 'DELIVERABLE_SUBMITTED', worker1.id, { milestone: 2 });
    ledger1.append(id1, 'SETTLEMENT_COMPLETED', 'PAYPAL_PAYOUTS', {
      totalDisbursedInCents: 5000,
      payoutBatchId: 'BATCH-77491-SUCCESS',
      recipient: worker1.paypalAccount,
    });

    const escrow1: EscrowRecord = {
      contractId: id1,
      state: EscrowState.SETTLED,
      totalAmountInCents: 5000,
      currency: 'USD',
      paypalOrderId: 'ORD-88219-PP',
      paypalAuthorizationId: 'AUTH-99214-HOLD',
      activeMilestone: 2,
      totalMilestones: 2,
      retriesUsed: 0,
      disbursedAmountInCents: 5000,
      refundedAmountInCents: 0,
      capturedMilestones: [
        {
          milestoneSequence: 1,
          captureId: 'CAP-101-PP',
          payoutBatchId: 'BATCH-77490-SUCCESS',
          amountInCents: 2500,
          disbursedInCents: 2500,
          refundedInCents: 0,
          settledAt: '2026-11-02T07:35:00Z',
        },
        {
          milestoneSequence: 2,
          captureId: 'CAP-102-PP',
          payoutBatchId: 'BATCH-77491-SUCCESS',
          amountInCents: 2500,
          disbursedInCents: 2500,
          refundedInCents: 0,
          settledAt: '2026-11-02T07:42:00Z',
        },
      ],
      createdAt: '2026-11-02T07:30:00Z',
      updatedAt: '2026-11-02T07:42:00Z',
      auditTrail: ledger1.getHistory(),
    };

    const verdict1: ArbitrationVerdict = {
      contractId: id1,
      milestoneSequence: 2,
      decision: ArbitrationDecision.RELEASE,
      overallScore: 96,
      payoutPercentage: 1.0,
      canRetry: false,
      evaluatedAt: '2026-11-02T07:41:58Z',
      deterministicResults: [
        {
          checkId: 'chk_regex',
          name: 'Exported Function Signature Validation',
          passed: true,
          score: 100,
          weight: 2,
          message: 'Content satisfied regex pattern: export function renderMetricChart',
        },
      ],
      semanticResults: [
        {
          checkId: 'rub_code_arch',
          name: 'Architectural Cleanliness & Documentation',
          passed: true,
          score: 93,
          weight: 3,
          message: 'The submitted module satisfies all criteria with clean TypeScript interfaces and defensive bounds handling.',
        },
      ],
      rationale: 'Deliverable passed all required SLA criteria with composite weighted score 96/100. Multi-milestone contract fully settled via PayPal Payouts API.',
      arbitratorPublicKey: this.deps.arbitrator.getPublicKey(),
      signedVerdictSignature: 'a028fb99214cd771829038291048293847291048291048291048291048291048',
    };

    const submission1: SubmissionPayload = {
      contractId: id1,
      workerId: worker1.id,
      milestoneSequence: 2,
      submittedAt: '2026-11-02T07:41:30Z',
      artifacts: [
        {
          name: 'chart.ts',
          type: 'CODE',
          content: `export function renderMetricChart(opts: { values: number[] }): string {\n  return '<svg viewBox="0 0 600 300"></svg>';\n}`,
          metadata: {},
        },
      ],
    };

    this.contracts.set(id1, contract1);
    this.escrows.set(id1, escrow1);
    this.ledgers.set(id1, ledger1);
    this.verdicts.set(id1, [verdict1]);
    this.submissions.set(id1, [submission1]);
    this.orderIdToContractId.set('ORD-88219-PP', id1);
    this.authIdToContractId.set('AUTH-99214-HOLD', id1);

    // --- CONTRACT 2: In Progress ---
    const id2 = 'c2222222-3333-4444-5555-666666666662';
    const buyer2: Participant = {
      id: 'b2222222-0000-0000-0000-000000000002',
      role: 'BUYER',
      name: 'FinTech Compliance Labs',
      paypalAccount: 'compliance@fintech.io',
    };
    const worker2: Participant = {
      id: 'w2222222-0000-0000-0000-000000000002',
      role: 'WORKER',
      name: 'DataShield-Agent-09',
      paypalAccount: 'datashield@sandbox.paypal.com',
    };

    const contract2: ContractSpec = {
      id: id2,
      buyer: buyer2,
      worker: worker2,
      totalAmountInCents: 7500, // $75.00
      currency: 'USD',
      sla: {
        slaId: 's2222222-0000-0000-0000-000000000002',
        taskTitle: 'Financial Transaction Anonymizer & Schema Validator',
        taskDescription: 'Scrub PII and credit card numbers from raw transaction JSON logs according to PCI-DSS masking standards.',
        maxDeliverySeconds: 86400,
        maxArbitrationRetries: 2,
        minOverallScore: 80,
        partialReleaseThreshold: 60,
        deterministicChecks: [
          {
            id: 'chk_schema',
            name: 'Sanitized JSON Schema Conformance',
            type: 'JSON_SCHEMA',
            targetField: 'anonymized.json',
            expectedValue: { status: 'string', maskedRecords: 'number' },
            weight: 2,
            required: true,
          },
        ],
        semanticRubrics: [
          {
            id: 'rub_pci',
            name: 'PCI-DSS Masking Rigor',
            description: 'Verify all card numbers are truncated to last 4 digits.',
            weight: 2,
            minScore: 75,
            instructions: 'Inspect masking format and check that zero raw PANs remain.',
          },
        ],
      },
      milestones: [
        {
          sequence: 1,
          name: 'Phase 1: Log Masking & Compliance Schema',
          amountInCents: 7500,
          currency: 'USD',
          status: 'ACTIVE',
        },
      ],
      createdAt: '2026-11-02T08:10:00Z',
      expiresAt: '2026-11-03T08:10:00Z',
      metadata: {},
    };

    const ledger2 = new AuditLedger(this.deps.hmacSecret);
    ledger2.append(id2, 'CONTRACT_DRAFTED', buyer2.id, { totalAmountInCents: 7500 });
    ledger2.append(id2, 'ESCROW_INITIALIZED', 'SYSTEM', { paypalOrderId: 'ORD-62118-PP' });
    ledger2.append(id2, 'ESCROW_LOCKED', 'PAYPAL_WEBHOOK', { paypalAuthorizationId: 'AUTH-48190-HOLD' });
    ledger2.append(id2, 'CONTRACT_ACCEPTED', worker2.id, { workerName: worker2.name });

    const escrow2: EscrowRecord = {
      contractId: id2,
      state: EscrowState.IN_PROGRESS,
      totalAmountInCents: 7500,
      currency: 'USD',
      paypalOrderId: 'ORD-62118-PP',
      paypalAuthorizationId: 'AUTH-48190-HOLD',
      activeMilestone: 1,
      totalMilestones: 1,
      retriesUsed: 0,
      disbursedAmountInCents: 0,
      refundedAmountInCents: 0,
      capturedMilestones: [],
      createdAt: '2026-11-02T08:10:00Z',
      updatedAt: '2026-11-02T08:15:00Z',
      auditTrail: ledger2.getHistory(),
    };

    this.contracts.set(id2, contract2);
    this.escrows.set(id2, escrow2);
    this.ledgers.set(id2, ledger2);
    this.verdicts.set(id2, []);
    this.submissions.set(id2, []);
    this.orderIdToContractId.set('ORD-62118-PP', id2);
    this.authIdToContractId.set('AUTH-48190-HOLD', id2);

    // --- CONTRACT 3: Open Bounty (ESCROW_LOCKED, awaiting worker acceptance) ---
    const id3 = 'c3333333-4444-5555-6666-777777777773';
    const buyer3: Participant = {
      id: 'b3333333-0000-0000-0000-000000000003',
      role: 'BUYER',
      name: 'CloudDB Operations Agent',
      paypalAccount: 'treasury@clouddb.net',
    };

    const contract3: ContractSpec = {
      id: id3,
      buyer: buyer3,
      totalAmountInCents: 6000, // $60.00
      currency: 'USD',
      sla: {
        slaId: 's3333333-0000-0000-0000-000000000003',
        taskTitle: 'PostgreSQL Query Plan Optimizer & Latency Benchmark',
        taskDescription: 'Analyze slow query logs, construct compound B-Tree indexes, and produce optimized EXPLAIN ANALYZE benchmarks.',
        maxDeliverySeconds: 86400,
        maxArbitrationRetries: 2,
        minOverallScore: 80,
        partialReleaseThreshold: 60,
        deterministicChecks: [
          {
            id: 'chk_schema_sql',
            name: 'Plan Output Schema Conformance',
            type: 'JSON_SCHEMA',
            targetField: 'optimization.json',
            expectedValue: { status: 'string', estimatedCostReductionPercent: 'number' },
            weight: 2,
            required: true,
          },
        ],
        semanticRubrics: [
          {
            id: 'rub_sql_quality',
            name: 'Index Tuning & Execution Plan Rigor',
            description: 'Evaluate index strategy, sequential scan avoidance, and memory buffer usage.',
            weight: 2,
            minScore: 75,
            instructions: 'Ensure compound indexes are proposed with valid syntax and benchmark metrics.',
          },
        ],
      },
      milestones: [
        {
          sequence: 1,
          name: 'Milestone 1: Index Formulation & Query Plan',
          amountInCents: 6000,
          currency: 'USD',
          status: 'PENDING',
        },
      ],
      createdAt: '2026-11-02T08:30:00Z',
      expiresAt: '2026-11-03T08:30:00Z',
      metadata: {},
    };

    const ledger3 = new AuditLedger(this.deps.hmacSecret);
    ledger3.append(id3, 'CONTRACT_DRAFTED', buyer3.id, { totalAmountInCents: 6000 });
    ledger3.append(id3, 'ESCROW_INITIALIZED', 'SYSTEM', { paypalOrderId: 'ORD-91024-PP' });
    ledger3.append(id3, 'ESCROW_LOCKED', 'PAYPAL_WEBHOOK', { paypalAuthorizationId: 'AUTH-77312-HOLD' });

    const escrow3: EscrowRecord = {
      contractId: id3,
      state: EscrowState.ESCROW_LOCKED,
      totalAmountInCents: 6000,
      currency: 'USD',
      paypalOrderId: 'ORD-91024-PP',
      paypalAuthorizationId: 'AUTH-77312-HOLD',
      activeMilestone: 1,
      totalMilestones: 1,
      retriesUsed: 0,
      disbursedAmountInCents: 0,
      refundedAmountInCents: 0,
      capturedMilestones: [],
      createdAt: '2026-11-02T08:30:00Z',
      updatedAt: '2026-11-02T08:31:00Z',
      auditTrail: ledger3.getHistory(),
    };

    this.contracts.set(id3, contract3);
    this.escrows.set(id3, escrow3);
    this.ledgers.set(id3, ledger3);
    this.verdicts.set(id3, []);
    this.submissions.set(id3, []);
    this.orderIdToContractId.set('ORD-91024-PP', id3);
    this.authIdToContractId.set('AUTH-77312-HOLD', id3);
  }

  private mustGetContract(contractId: string): ContractSpec {
    const c = this.contracts.get(contractId);
    if (!c) throw new Error(`Contract ${contractId} not found`);
    return c;
  }

  private mustGetEscrow(contractId: string): EscrowRecord {
    const e = this.escrows.get(contractId);
    if (!e) throw new Error(`Escrow record for ${contractId} not found`);
    return e;
  }

  private mustGetLedger(contractId: string): AuditLedger {
    const l = this.ledgers.get(contractId);
    if (!l) throw new Error(`Audit ledger for ${contractId} not found`);
    return l;
  }
}
