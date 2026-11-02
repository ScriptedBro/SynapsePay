import { z } from 'zod';

export enum ArbitrationDecision {
  RELEASE = 'RELEASE',
  PARTIAL_RELEASE = 'PARTIAL_RELEASE',
  REJECT = 'REJECT',
  DISPUTE = 'DISPUTE',
}

export const ArbitrationDecisionSchema = z.nativeEnum(ArbitrationDecision);

export const CheckResultSchema = z.object({
  checkId: z.string(),
  name: z.string(),
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  weight: z.number().default(1),
  message: z.string(),
  details: z.record(z.any()).optional(),
});

export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ArbitrationVerdictSchema = z.object({
  contractId: z.string().uuid(),
  milestoneSequence: z.number().int().min(1),
  decision: ArbitrationDecisionSchema,
  overallScore: z.number().min(0).max(100),
  payoutPercentage: z.number().min(0).max(1), // 0.0 to 1.0 (e.g. 0.7 for 70% partial release)
  canRetry: z.boolean(),
  evaluatedAt: z.string().datetime(),
  deterministicResults: z.array(CheckResultSchema),
  semanticResults: z.array(CheckResultSchema),
  rationale: z.string(),
  arbitratorPublicKey: z.string(), // Ed25519 public key of the signing arbitrator
  signedVerdictSignature: z.string(), // Ed25519 signature over verdict canonical JSON
});

export type ArbitrationVerdict = z.infer<typeof ArbitrationVerdictSchema>;
