import { z } from 'zod';

export enum EscrowState {
  DRAFT = 'DRAFT',
  NEGOTIATING = 'NEGOTIATING',
  ESCROW_PENDING = 'ESCROW_PENDING',
  ESCROW_LOCKED = 'ESCROW_LOCKED',
  IN_PROGRESS = 'IN_PROGRESS',
  ARBITRATION_PENDING = 'ARBITRATION_PENDING',
  REMEDIATION_REQUIRED = 'REMEDIATION_REQUIRED',
  MILESTONE_SETTLED = 'MILESTONE_SETTLED',
  DISPUTED = 'DISPUTED',
  SETTLED = 'SETTLED',
  VOIDED = 'VOIDED',
}

export const EscrowStateSchema = z.nativeEnum(EscrowState);

export const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  contractId: z.string().uuid(),
  sequence: z.number().int().min(0),
  previousHash: z.string().length(64),
  currentHash: z.string().length(64),
  timestamp: z.string().datetime(),
  event: z.string(),
  actor: z.string(),
  payload: z.record(z.any()),
  signature: z.string(), // HMAC or Ed25519 signature
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const CapturedMilestoneRecordSchema = z.object({
  milestoneSequence: z.number().int().min(1),
  captureId: z.string(),
  payoutBatchId: z.string().optional(),
  payoutItemId: z.string().optional(),
  amountInCents: z.number().int().positive(),
  disbursedInCents: z.number().int().min(0),
  refundedInCents: z.number().int().min(0),
  settledAt: z.string().datetime(),
});

export type CapturedMilestoneRecord = z.infer<typeof CapturedMilestoneRecordSchema>;

export const EscrowRecordSchema = z.object({
  contractId: z.string().uuid(),
  state: EscrowStateSchema,
  totalAmountInCents: z.number().int().positive(),
  currency: z.string().length(3),
  paypalOrderId: z.string().optional(),
  paypalAuthorizationId: z.string().optional(),
  activeMilestone: z.number().int().min(1).default(1),
  totalMilestones: z.number().int().min(1).default(1),
  retriesUsed: z.number().int().min(0).default(0),
  disbursedAmountInCents: z.number().int().min(0).default(0),
  refundedAmountInCents: z.number().int().min(0).default(0),
  capturedMilestones: z.array(CapturedMilestoneRecordSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  auditTrail: z.array(AuditEntrySchema).default([]),
});

export type EscrowRecord = z.infer<typeof EscrowRecordSchema>;
