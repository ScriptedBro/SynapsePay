import { z } from 'zod';

export enum EscrowState {
  DRAFT = 'DRAFT',
  ESCROW_PENDING = 'ESCROW_PENDING',
  ESCROW_LOCKED = 'ESCROW_LOCKED',
  IN_PROGRESS = 'IN_PROGRESS',
  ARBITRATION_PENDING = 'ARBITRATION_PENDING',
  REMEDIATION_REQUIRED = 'REMEDIATION_REQUIRED',
  SETTLED = 'SETTLED',
  VOIDED = 'VOIDED',
  DISPUTED = 'DISPUTED',
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
  signature: z.string(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const EscrowRecordSchema = z.object({
  contractId: z.string().uuid(),
  state: EscrowStateSchema,
  totalAmount: z.number().positive(),
  currency: z.string().length(3),
  paypalOrderId: z.string().optional(),
  paypalAuthorizationId: z.string().optional(),
  paypalPayoutBatchId: z.string().optional(),
  payoutTransactionId: z.string().optional(),
  activeMilestone: z.number().int().min(1).default(1),
  retriesUsed: z.number().int().min(0).default(0),
  disbursedAmount: z.number().min(0).default(0),
  refundedAmount: z.number().min(0).default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  auditTrail: z.array(AuditEntrySchema).default([]),
});

export type EscrowRecord = z.infer<typeof EscrowRecordSchema>;
