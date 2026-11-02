import { z } from 'zod';

export const AgentRoleSchema = z.enum(['BUYER', 'WORKER', 'ARBITRATOR', 'ADMIN']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const ParticipantSchema = z.object({
  id: z.string().uuid(),
  role: AgentRoleSchema,
  name: z.string().min(1).max(100),
  paypalAccount: z.string().email(),
  publicKey: z.string().optional(), // Ed25519 public key (hex or base64)
  apiKeyHash: z.string().optional(),
});

export type Participant = z.infer<typeof ParticipantSchema>;

export const DeterministicCheckTypeSchema = z.enum([
  'HASH_EQUAL',
  'JSON_SCHEMA',
  'REGEX_MATCH',
  'NUMERIC_THRESHOLD',
  'SYNTAX_VALID',
  'CUSTOM_ASSERTION',
]);
export type DeterministicCheckType = z.infer<typeof DeterministicCheckTypeSchema>;

export const DeterministicCheckSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: DeterministicCheckTypeSchema,
  targetField: z.string(),
  expectedValue: z.any().optional(),
  tolerance: z.number().optional(),
  weight: z.number().min(0.1).max(10).default(1),
  required: z.boolean().default(true),
});

export type DeterministicCheckSpec = z.infer<typeof DeterministicCheckSpecSchema>;

export const SemanticRubricSpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  weight: z.number().min(0.1).max(10).default(1),
  minScore: z.number().min(0).max(100).default(80),
  instructions: z.string().min(10),
});

export type SemanticRubricSpec = z.infer<typeof SemanticRubricSpecSchema>;

export const SLASpecSchema = z.object({
  slaId: z.string().uuid(),
  taskTitle: z.string().min(1).max(150),
  taskDescription: z.string().min(1),
  maxDeliverySeconds: z.number().int().positive().default(86400),
  maxArbitrationRetries: z.number().int().min(0).default(2),
  deterministicChecks: z.array(DeterministicCheckSpecSchema).default([]),
  semanticRubrics: z.array(SemanticRubricSpecSchema).default([]),
  minOverallScore: z.number().min(0).max(100).default(85),
  partialReleaseThreshold: z.number().min(0).max(100).optional().default(60), // Score threshold for PARTIAL_RELEASE
});

export type SLASpec = z.infer<typeof SLASpecSchema>;

export const MilestoneStatusSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'VERIFIED',
  'SETTLED',
  'FAILED',
]);
export type MilestoneStatus = z.infer<typeof MilestoneStatusSchema>;

export const MilestoneSchema = z.object({
  sequence: z.number().int().min(1),
  name: z.string().min(1),
  amountInCents: z.number().int().positive(), // Minor units: 5000 = $50.00
  currency: z.string().length(3).default('USD'),
  status: MilestoneStatusSchema.default('PENDING'),
});

export type Milestone = z.infer<typeof MilestoneSchema>;

export const ContractSpecSchema = z
  .object({
    id: z.string().uuid().optional(), // Server-generated if omitted
    buyer: ParticipantSchema,
    worker: ParticipantSchema.optional(),
    totalAmountInCents: z.number().int().positive(), // Minor units: 10000 = $100.00
    currency: z.string().length(3).default('USD'),
    sla: SLASpecSchema,
    milestones: z.array(MilestoneSchema).min(1),
    createdAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    metadata: z.record(z.any()).default({}),
  })
  .refine(
    (data) => {
      // Invariant: Milestone amounts must sum up exactly to totalAmountInCents
      const milestoneSum = data.milestones.reduce((acc, m) => acc + m.amountInCents, 0);
      return milestoneSum === data.totalAmountInCents;
    },
    {
      message: 'Invariant violated: Sum of milestone amounts must exactly match totalAmountInCents',
      path: ['milestones'],
    }
  )
  .refine(
    (data) => {
      // Invariant: All milestones must have the exact same currency as contract
      return data.milestones.every((m) => m.currency === data.currency);
    },
    {
      message: 'Invariant violated: All milestones must share the contract currency code',
      path: ['milestones'],
    }
  );

export type ContractSpec = z.infer<typeof ContractSpecSchema>;

export const DeliverableArtifactSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['CODE', 'DOCUMENTATION', 'DATASET', 'API_ENDPOINT', 'MULTIMODAL', 'LOGS']),
  content: z.string(),
  sha256: z.string().length(64).optional(),
  metadata: z.record(z.any()).optional().default({}),
});

export type DeliverableArtifact = z.infer<typeof DeliverableArtifactSchema>;

export const SubmissionPayloadSchema = z.object({
  contractId: z.string().uuid(),
  workerId: z.string().uuid(),
  milestoneSequence: z.number().int().min(1).default(1),
  submittedAt: z.string().datetime().optional(),
  artifacts: z.array(DeliverableArtifactSchema).min(1),
  notes: z.string().optional(),
  workerSignature: z.string().optional(), // Ed25519 signature from worker over artifact hashes
});

export type SubmissionPayload = z.infer<typeof SubmissionPayloadSchema>;

export const NegotiationProposalSchema = z.object({
  contractId: z.string().uuid(),
  proposedBy: z.enum(['BUYER', 'WORKER']),
  proposedAmountInCents: z.number().int().positive(),
  proposedDeliverySeconds: z.number().int().positive(),
  notes: z.string().optional(),
});

export type NegotiationProposal = z.infer<typeof NegotiationProposalSchema>;
