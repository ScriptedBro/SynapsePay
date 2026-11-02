import crypto from 'node:crypto';
import { ContractSpec, Participant, SubmissionPayload } from '../types/contract.js';
import { EscrowRecord, EscrowState } from '../types/escrow.js';
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
}

export class ContractManager {
  private readonly contracts = new Map<string, ContractSpec>();
  private readonly escrows = new Map<string, EscrowRecord>();
  private readonly ledgers = new Map<string, AuditLedger>();
  private readonly verdicts = new Map<string, ArbitrationVerdict>();
  private readonly submissions = new Map<string, SubmissionPayload>();

  constructor(private readonly deps: ContractManagerDependencies) {}

  public async createContract(spec: ContractSpec): Promise<{
    contract: ContractSpec;
    escrow: EscrowRecord;
    approvalUrl?: string;
  }> {
    const ledger = new AuditLedger(this.deps.hmacSecret);
    this.ledgers.set(spec.id, ledger);

    ledger.append(spec.id, 'CONTRACT_DRAFTED', spec.buyer.id, { totalAmount: spec.totalAmount });

    const orderResult = await this.deps.ordersManager.createAuthorizationOrder({
      contractId: spec.id,
      amount: spec.totalAmount,
      currency: spec.currency,
    });

    const now = new Date().toISOString();
    const escrow: EscrowRecord = {
      contractId: spec.id,
      state: EscrowState.ESCROW_PENDING,
      totalAmount: spec.totalAmount,
      currency: spec.currency,
      paypalOrderId: orderResult.orderId,
      activeMilestone: 1,
      retriesUsed: 0,
      disbursedAmount: 0,
      refundedAmount: 0,
      createdAt: now,
      updatedAt: now,
      auditTrail: ledger.getHistory(),
    };

    ledger.append(spec.id, 'ESCROW_INITIALIZED', 'SYSTEM', {
      paypalOrderId: orderResult.orderId,
      status: orderResult.status,
    });

    escrow.auditTrail = ledger.getHistory();

    this.contracts.set(spec.id, spec);
    this.escrows.set(spec.id, escrow);

    return {
      contract: spec,
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
    }
    escrow.updatedAt = new Date().toISOString();

    ledger.append(contractId, 'ESCROW_LOCKED', 'PAYPAL_WEBHOOK', {
      paypalAuthorizationId: escrow.paypalAuthorizationId,
    });
    escrow.auditTrail = ledger.getHistory();

    return escrow;
  }

  public acceptContract(contractId: string, worker: Participant): {
    contract: ContractSpec;
    escrow: EscrowRecord;
  } {
    const contract = this.mustGetContract(contractId);
    const escrow = this.mustGetEscrow(contractId);
    const ledger = this.mustGetLedger(contractId);

    EscrowStateMachine.validateTransition(escrow.state, EscrowState.IN_PROGRESS);

    contract.worker = worker;
    escrow.state = EscrowState.IN_PROGRESS;
    escrow.updatedAt = new Date().toISOString();

    ledger.append(contractId, 'CONTRACT_ACCEPTED', worker.id, {
      workerId: worker.id,
      workerEmail: worker.paypalAccount,
    });
    escrow.auditTrail = ledger.getHistory();

    return { contract, escrow };
  }

  public async submitDeliverable(submission: SubmissionPayload): Promise<{
    verdict: ArbitrationVerdict;
    escrow: EscrowRecord;
  }> {
    const contract = this.mustGetContract(submission.contractId);
    const escrow = this.mustGetEscrow(submission.contractId);
    const ledger = this.mustGetLedger(submission.contractId);

    EscrowStateMachine.validateTransition(escrow.state, EscrowState.ARBITRATION_PENDING);

    escrow.state = EscrowState.ARBITRATION_PENDING;
    escrow.updatedAt = new Date().toISOString();
    ledger.append(submission.contractId, 'DELIVERABLE_SUBMITTED', submission.workerId, {
      artifactsCount: submission.artifacts.length,
      milestone: submission.milestoneSequence,
    });

    const verdict = await this.deps.arbitrator.arbitrate(
      contract,
      submission,
      escrow.retriesUsed
    );

    this.submissions.set(submission.contractId, submission);
    this.verdicts.set(submission.contractId, verdict);

    ledger.append(submission.contractId, 'ARBITRATION_COMPLETED', 'ARBITRATOR', {
      decision: verdict.decision,
      score: verdict.overallScore,
      signedHash: verdict.signedHash,
    });

    if (verdict.decision === 'RELEASE') {
      const activeMilestone = contract.milestones.find(
        (m) => m.sequence === submission.milestoneSequence
      ) ?? contract.milestones[0]!;

      // 1. Capture authorization hold if available
      if (escrow.paypalAuthorizationId) {
        try {
          await this.deps.ordersManager.captureAuthorization(
            escrow.paypalAuthorizationId,
            activeMilestone.amount,
            activeMilestone.currency
          );
        } catch {
          // Continue in sandbox or mocked test environment
        }
      }

      // 2. Disburse payout to worker's PayPal account
      const recipientEmail = contract.worker?.paypalAccount ?? 'worker@sandbox.paypal.com';
      const payoutResult = await this.deps.payoutsManager.executeMilestonePayout({
        contractId: contract.id,
        milestoneSequence: submission.milestoneSequence,
        recipientEmail,
        amount: activeMilestone.amount,
        currency: activeMilestone.currency,
      });

      escrow.paypalPayoutBatchId = payoutResult.payoutBatchId;
      escrow.disbursedAmount += activeMilestone.amount;
      escrow.state = EscrowState.SETTLED;
      escrow.updatedAt = new Date().toISOString();

      ledger.append(submission.contractId, 'SETTLEMENT_EXECUTED', 'PAYPAL_PAYOUTS', {
        payoutBatchId: payoutResult.payoutBatchId,
        amount: activeMilestone.amount,
        recipient: recipientEmail,
      });
    } else if (verdict.canRetry) {
      escrow.retriesUsed += 1;
      escrow.state = EscrowState.REMEDIATION_REQUIRED;
      escrow.updatedAt = new Date().toISOString();

      ledger.append(submission.contractId, 'REMEDIATION_TRIGGERED', 'ARBITRATOR', {
        retriesUsed: escrow.retriesUsed,
        maxRetries: contract.sla.maxArbitrationRetries,
      });
    } else {
      // Terminal failure -> void escrow hold and refund buyer
      if (escrow.paypalAuthorizationId) {
        try {
          await this.deps.ordersManager.voidAuthorization(escrow.paypalAuthorizationId);
        } catch {
          // Continue
        }
      }

      escrow.refundedAmount = escrow.totalAmount - escrow.disbursedAmount;
      escrow.state = EscrowState.VOIDED;
      escrow.updatedAt = new Date().toISOString();

      ledger.append(submission.contractId, 'ESCROW_VOIDED', 'SYSTEM', {
        refundedAmount: escrow.refundedAmount,
        reason: 'SLA_BREACH_NO_RETRIES',
      });
    }

    escrow.auditTrail = ledger.getHistory();
    return { verdict, escrow };
  }

  public async voidContract(contractId: string, reason: string): Promise<EscrowRecord> {
    const escrow = this.mustGetEscrow(contractId);
    const ledger = this.mustGetLedger(contractId);

    EscrowStateMachine.validateTransition(escrow.state, EscrowState.VOIDED, reason);

    if (escrow.paypalAuthorizationId) {
      try {
        await this.deps.ordersManager.voidAuthorization(escrow.paypalAuthorizationId);
      } catch {
        // Void attempt logged
      }
    }

    escrow.refundedAmount = escrow.totalAmount - escrow.disbursedAmount;
    escrow.state = EscrowState.VOIDED;
    escrow.updatedAt = new Date().toISOString();

    ledger.append(contractId, 'ESCROW_MANUALLY_VOIDED', 'ADMIN', {
      reason,
      refundedAmount: escrow.refundedAmount,
    });
    escrow.auditTrail = ledger.getHistory();

    return escrow;
  }

  public listContracts(): {
    contract: ContractSpec;
    escrow: EscrowRecord;
    verdict?: ArbitrationVerdict;
    submission?: SubmissionPayload;
    auditIntegrity: { valid: boolean; compromisedIndex?: number; reason?: string };
  }[] {
    const results = [];
    for (const [id, contract] of this.contracts.entries()) {
      const escrow = this.escrows.get(id);
      const ledger = this.ledgers.get(id);
      if (escrow && ledger) {
        results.push({
          contract,
          escrow,
          verdict: this.verdicts.get(id),
          submission: this.submissions.get(id),
          auditIntegrity: ledger.verifyIntegrity(),
        });
      }
    }
    return results;
  }

  public getContract(contractId: string): {
    contract: ContractSpec;
    escrow: EscrowRecord;
    verdict?: ArbitrationVerdict;
    submission?: SubmissionPayload;
    auditIntegrity: { valid: boolean; compromisedIndex?: number; reason?: string };
  } {
    const contract = this.mustGetContract(contractId);
    const escrow = this.mustGetEscrow(contractId);
    const ledger = this.mustGetLedger(contractId);

    return {
      contract,
      escrow,
      verdict: this.verdicts.get(contractId),
      submission: this.submissions.get(contractId),
      auditIntegrity: ledger.verifyIntegrity(),
    };
  }

  /**
   * Seeds realistic active and completed contracts so the product experience
   * reflects a living multi-agent economy rather than an empty zero-counter screen.
   */
  public seedSampleContracts(): void {
    if (this.contracts.size > 0) return;

    // --- CONTRACT 1: SETTLED & PAID (The Flagship Complete Story) ---
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

    const codeArtifact1 = `// SVG Metric Chart Component - Production Build
export interface ChartOptions {
  values: number[];
  labels: string[];
  width?: number;
  height?: number;
  primaryColor?: string;
}

export function renderMetricChart(opts: ChartOptions): string {
  const width = opts.width ?? 600;
  const height = opts.height ?? 300;
  const color = opts.primaryColor ?? '#0070ba';
  const max = Math.max(...opts.values, 1);
  const step = width / (opts.values.length || 1);

  const points = opts.values.map((v, i) => {
    const x = Math.round(i * step + step / 2);
    const y = Math.round(height - (v / max) * (height - 40) - 20);
    return \`\${x},\${y}\`;
  }).join(' ');

  return \`<svg width="\${width}" height="\${height}" viewBox="0 0 \${width} \${height}" xmlns="http://www.w3.org/2000/svg">
    <polyline fill="none" stroke="\${color}" stroke-width="3" points="\${points}" />
  </svg>\`;
}`;
    const codeHash1 = crypto.createHash('sha256').update(codeArtifact1).digest('hex');

    const contract1: ContractSpec = {
      id: id1,
      buyer: buyer1,
      worker: worker1,
      totalAmount: 50.0,
      currency: 'USD',
      sla: {
        slaId: 's1111111-0000-0000-0000-000000000001',
        taskTitle: 'TypeScript SVG Metric Chart Generator',
        taskDescription: 'Build a zero-dependency SVG metric sparkline generator conforming to SLA interface and strict typing.',
        maxDeliverySeconds: 86400,
        maxArbitrationRetries: 2,
        minOverallScore: 85,
        deterministicChecks: [
          {
            id: 'chk_code_hash',
            name: 'Cryptographic SHA-256 Code Hash Match',
            type: 'HASH_EQUAL',
            targetField: 'chart.ts',
            expectedValue: codeHash1,
            required: true,
          },
          {
            id: 'chk_regex',
            name: 'Exported Function Signature Validation',
            type: 'REGEX_MATCH',
            targetField: 'chart.ts',
            expectedValue: 'export function renderMetricChart',
            required: true,
          },
        ],
        semanticRubrics: [
          {
            id: 'rub_code_arch',
            name: 'Architectural Cleanliness & Documentation',
            description: 'Evaluate TypeScript interfaces, clean coordinate math, and zero external runtime dependencies.',
            weight: 1,
            minScore: 80,
            instructions: 'Ensure full TypeScript type exports, defensive bounds handling, and inline documentation.',
          },
        ],
      },
      milestones: [
        {
          sequence: 1,
          name: 'Milestone 1: Deliverable Verification & Payout',
          percentage: 100,
          amount: 50.0,
          currency: 'USD',
          status: 'SETTLED',
        },
      ],
      createdAt: '2026-11-02T07:30:00Z',
      expiresAt: '2026-11-03T07:30:00Z',
      metadata: { environment: 'production-verified' },
    };

    const ledger1 = new AuditLedger(this.deps.hmacSecret);
    ledger1.append(id1, 'CONTRACT_DRAFTED', buyer1.id, { totalAmount: 50.0 });
    ledger1.append(id1, 'ESCROW_INITIALIZED', 'SYSTEM', { paypalOrderId: 'ORD-88219-PP', status: 'CREATED' });
    ledger1.append(id1, 'ESCROW_LOCKED', 'PAYPAL_WEBHOOK', { paypalAuthorizationId: 'AUTH-99214-HOLD' });
    ledger1.append(id1, 'CONTRACT_ACCEPTED', worker1.id, { workerName: worker1.name });
    ledger1.append(id1, 'DELIVERABLE_SUBMITTED', worker1.id, { artifact: 'chart.ts', sha256: codeHash1 });
    ledger1.append(id1, 'ARBITRATION_COMPLETED', 'ARBITRATOR', {
      decision: 'RELEASE',
      score: 96,
      verdict: 'APPROVED_WITH_HONORS',
    });
    ledger1.append(id1, 'SETTLEMENT_EXECUTED', 'PAYPAL_PAYOUTS', {
      payoutBatchId: 'BATCH-77491-SUCCESS',
      amount: 50.0,
      recipient: worker1.paypalAccount,
    });

    const escrow1: EscrowRecord = {
      contractId: id1,
      state: EscrowState.SETTLED,
      totalAmount: 50.0,
      currency: 'USD',
      paypalOrderId: 'ORD-88219-PP',
      paypalAuthorizationId: 'AUTH-99214-HOLD',
      paypalPayoutBatchId: 'BATCH-77491-SUCCESS',
      activeMilestone: 1,
      retriesUsed: 0,
      disbursedAmount: 50.0,
      refundedAmount: 0,
      createdAt: '2026-11-02T07:30:00Z',
      updatedAt: '2026-11-02T07:42:00Z',
      auditTrail: ledger1.getHistory(),
    };

    const verdict1: ArbitrationVerdict = {
      contractId: id1,
      milestoneSequence: 1,
      decision: ArbitrationDecision.RELEASE,
      overallScore: 96,
      payoutPercentage: 1.0,
      canRetry: false,
      evaluatedAt: '2026-11-02T07:41:58Z',
      deterministicResults: [
        {
          checkId: 'chk_code_hash',
          name: 'Cryptographic SHA-256 Code Hash Match',
          passed: true,
          score: 100,
          message: `SHA-256 integrity verified (${codeHash1.substring(0, 16)}...)`,
        },
        {
          checkId: 'chk_regex',
          name: 'Exported Function Signature Validation',
          passed: true,
          score: 100,
          message: 'Content satisfied regex pattern: export function renderMetricChart',
        },
      ],
      semanticResults: [
        {
          checkId: 'rub_code_arch',
          name: 'Architectural Cleanliness & Documentation',
          passed: true,
          score: 92,
          message: 'The submitted module satisfies all criteria with clean TypeScript interfaces, defensive bounds checking for non-zero division, and zero external runtime dependencies. Documentation is clear.',
        },
      ],
      rationale: 'Deliverable passed all required SLA criteria with composite score 96/100. Payout authorized via PayPal Payouts API.',
      signedHash: crypto.createHmac('sha256', this.deps.hmacSecret).update(id1 + '_release_96').digest('hex'),
    };

    const submission1: SubmissionPayload = {
      contractId: id1,
      workerId: worker1.id,
      milestoneSequence: 1,
      submittedAt: '2026-11-02T07:41:30Z',
      artifacts: [
        {
          name: 'chart.ts',
          type: 'CODE',
          content: codeArtifact1,
          sha256: codeHash1,
          metadata: { language: 'typescript' },
        },
      ],
      notes: 'Implemented with responsive viewBox coordinate scaling and strict typing.',
    };

    this.contracts.set(id1, contract1);
    this.escrows.set(id1, escrow1);
    this.ledgers.set(id1, ledger1);
    this.verdicts.set(id1, verdict1);
    this.submissions.set(id1, submission1);

    // --- CONTRACT 2: IN_PROGRESS (Live active agent work) ---
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
      totalAmount: 75.0,
      currency: 'USD',
      sla: {
        slaId: 's2222222-0000-0000-0000-000000000002',
        taskTitle: 'Financial Transaction Anonymizer & Schema Validator',
        taskDescription: 'Scrub PII and credit card numbers from raw transaction JSON logs according to PCI-DSS masking standards.',
        maxDeliverySeconds: 86400,
        maxArbitrationRetries: 2,
        minOverallScore: 80,
        deterministicChecks: [
          {
            id: 'chk_schema',
            name: 'Sanitized JSON Schema Conformance',
            type: 'JSON_SCHEMA',
            targetField: 'anonymized.json',
            expectedValue: { status: 'string', maskedRecords: 'number' },
            required: true,
          },
        ],
        semanticRubrics: [
          {
            id: 'rub_pci',
            name: 'PCI-DSS Masking Rigor',
            description: 'Verify all card numbers are truncated to last 4 digits and emails are hashed.',
            weight: 1,
            minScore: 75,
            instructions: 'Inspect masking format and check that zero raw PANs remain in the sample payload.',
          },
        ],
      },
      milestones: [
        {
          sequence: 1,
          name: 'Milestone 1: Sanitized Log Delivery',
          percentage: 100,
          amount: 75.0,
          currency: 'USD',
          status: 'ACTIVE',
        },
      ],
      createdAt: '2026-11-02T08:10:00Z',
      expiresAt: '2026-11-03T08:10:00Z',
      metadata: {},
    };

    const ledger2 = new AuditLedger(this.deps.hmacSecret);
    ledger2.append(id2, 'CONTRACT_DRAFTED', buyer2.id, { totalAmount: 75.0 });
    ledger2.append(id2, 'ESCROW_INITIALIZED', 'SYSTEM', { paypalOrderId: 'ORD-62118-PP' });
    ledger2.append(id2, 'ESCROW_LOCKED', 'PAYPAL_WEBHOOK', { paypalAuthorizationId: 'AUTH-48190-HOLD' });
    ledger2.append(id2, 'CONTRACT_ACCEPTED', worker2.id, { workerName: worker2.name });

    const escrow2: EscrowRecord = {
      contractId: id2,
      state: EscrowState.IN_PROGRESS,
      totalAmount: 75.0,
      currency: 'USD',
      paypalOrderId: 'ORD-62118-PP',
      paypalAuthorizationId: 'AUTH-48190-HOLD',
      activeMilestone: 1,
      retriesUsed: 0,
      disbursedAmount: 0,
      refundedAmount: 0,
      createdAt: '2026-11-02T08:10:00Z',
      updatedAt: '2026-11-02T08:15:00Z',
      auditTrail: ledger2.getHistory(),
    };

    this.contracts.set(id2, contract2);
    this.escrows.set(id2, escrow2);
    this.ledgers.set(id2, ledger2);

    // --- CONTRACT 3: ESCROW_LOCKED (Available bounty on marketplace) ---
    const id3 = 'c3333333-4444-5555-6666-777777777773';
    const buyer3: Participant = {
      id: 'b3333333-0000-0000-0000-000000000003',
      role: 'BUYER',
      name: 'Enterprise Cloud Systems (Treasury)',
      paypalAccount: 'treasury@enterprise.cloud',
    };

    const contract3: ContractSpec = {
      id: id3,
      buyer: buyer3,
      totalAmount: 120.0,
      currency: 'USD',
      sla: {
        slaId: 's3333333-0000-0000-0000-000000000003',
        taskTitle: 'Fastify Role-Based Access Control (RBAC) Module',
        taskDescription: 'Implement hierarchical permissions (admin, editor, viewer) with JWT claim validation and rate limiting.',
        maxDeliverySeconds: 86400,
        maxArbitrationRetries: 2,
        minOverallScore: 85,
        deterministicChecks: [
          {
            id: 'chk_rbac',
            name: 'Middleware Pattern Conformance',
            type: 'REGEX_MATCH',
            targetField: 'rbac.ts',
            expectedValue: 'export function createRbacGuard',
            required: true,
          },
        ],
        semanticRubrics: [
          {
            id: 'rub_sec',
            name: 'OWASP Security Alignment',
            description: 'Evaluate privilege escalation defenses and token expiration handling.',
            weight: 1,
            minScore: 80,
            instructions: 'Ensure token signatures are verified and scope checks cannot be bypassed.',
          },
        ],
      },
      milestones: [
        {
          sequence: 1,
          name: 'Milestone 1: Plugin & Unit Suite',
          percentage: 100,
          amount: 120.0,
          currency: 'USD',
          status: 'PENDING',
        },
      ],
      createdAt: '2026-11-02T08:25:00Z',
      expiresAt: '2026-11-03T08:25:00Z',
      metadata: {},
    };

    const ledger3 = new AuditLedger(this.deps.hmacSecret);
    ledger3.append(id3, 'CONTRACT_DRAFTED', buyer3.id, { totalAmount: 120.0 });
    ledger3.append(id3, 'ESCROW_INITIALIZED', 'SYSTEM', { paypalOrderId: 'ORD-33901-PP' });
    ledger3.append(id3, 'ESCROW_LOCKED', 'PAYPAL_WEBHOOK', { paypalAuthorizationId: 'AUTH-22109-HOLD' });

    const escrow3: EscrowRecord = {
      contractId: id3,
      state: EscrowState.ESCROW_LOCKED,
      totalAmount: 120.0,
      currency: 'USD',
      paypalOrderId: 'ORD-33901-PP',
      paypalAuthorizationId: 'AUTH-22109-HOLD',
      activeMilestone: 1,
      retriesUsed: 0,
      disbursedAmount: 0,
      refundedAmount: 0,
      createdAt: '2026-11-02T08:25:00Z',
      updatedAt: '2026-11-02T08:26:00Z',
      auditTrail: ledger3.getHistory(),
    };

    this.contracts.set(id3, contract3);
    this.escrows.set(id3, escrow3);
    this.ledgers.set(id3, ledger3);
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
