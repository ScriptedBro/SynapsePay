import { z } from 'zod';

export const ParticipantSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['BUYER', 'WORKER']),
  name: z.string().min(1),
  paypalAccount: z.string().email(),
  publicKey: z.string().optional(),
});

export type Participant = z.infer<typeof ParticipantSchema>;

export const DeterministicCheckSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['HASH_EQUAL', 'JSON_SCHEMA', 'REGEX_MATCH', 'NUMERIC_THRESHOLD', 'CUSTOM_ASSERTION']),
  targetField: z.string(),
  expectedValue: z.any().optional(),
  tolerance: z.number().optional(),
  required: z.boolean().default(true),
});

export type DeterministicCheckSpec = z.infer<typeof DeterministicCheckSpecSchema>;

export const SemanticRubricSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  weight: z.number().min(0).max(1).default(1),
  minScore: z.number().min(0).max(100).default(80),
  instructions: z.string(),
});

export type SemanticRubricSpec = z.infer<typeof SemanticRubricSpecSchema>;

export const SLASpecSchema = z.object({
  slaId: z.string().uuid(),
  taskTitle: z.string().min(1),
  taskDescription: z.string().min(1),
  maxDeliverySeconds: z.number().positive(),
  maxArbitrationRetries: z.number().int().min(0).default(2),
  deterministicChecks: z.array(DeterministicCheckSpecSchema).default([]),
  semanticRubrics: z.array(SemanticRubricSpecSchema).default([]),
  minOverallScore: z.number().min(0).max(100).default(85),
});

export type SLASpec = z.infer<typeof SLASpecSchema>;

export const MilestoneSchema = z.object({
  sequence: z.number().int().min(1),
  name: z.string().min(1),
  percentage: z.number().min(1).max(100),
  amount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
  status: z.enum(['PENDING', 'ACTIVE', 'VERIFIED', 'SETTLED', 'FAILED']).default('PENDING'),
});

export type Milestone = z.infer<typeof MilestoneSchema>;

export const ContractSpecSchema = z.object({
  id: z.string().uuid(),
  buyer: ParticipantSchema,
  worker: ParticipantSchema.optional(),
  totalAmount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
  sla: SLASpecSchema,
  milestones: z.array(MilestoneSchema).min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  metadata: z.record(z.any()).default({}),
});

export type ContractSpec = z.infer<typeof ContractSpecSchema>;

export const DeliverableArtifactSchema = z.object({
  name: z.string(),
  type: z.enum(['CODE', 'DOCUMENTATION', 'DATASET', 'API_ENDPOINT', 'MULTIMODAL', 'LOGS']),
  content: z.string(),
  sha256: z.string().length(64).optional(),
  metadata: z.record(z.any()).default({}),
});

export type DeliverableArtifact = z.infer<typeof DeliverableArtifactSchema>;

export const SubmissionPayloadSchema = z.object({
  contractId: z.string().uuid(),
  workerId: z.string().uuid(),
  milestoneSequence: z.number().int().min(1).default(1),
  submittedAt: z.string().datetime(),
  artifacts: z.array(DeliverableArtifactSchema).min(1),
  notes: z.string().optional(),
});

export type SubmissionPayload = z.infer<typeof SubmissionPayloadSchema>;
