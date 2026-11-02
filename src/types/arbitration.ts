import { z } from 'zod';

export enum ArbitrationDecision {
  RELEASE = 'RELEASE',
  REJECT = 'REJECT',
  PARTIAL_RELEASE = 'PARTIAL_RELEASE',
}

export const ArbitrationDecisionSchema = z.nativeEnum(ArbitrationDecision);

export const CheckResultSchema = z.object({
  checkId: z.string(),
  name: z.string(),
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  message: z.string(),
  details: z.record(z.any()).optional(),
});

export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ArbitrationVerdictSchema = z.object({
  contractId: z.string().uuid(),
  milestoneSequence: z.number().int().min(1),
  decision: ArbitrationDecisionSchema,
  overallScore: z.number().min(0).max(100),
  payoutPercentage: z.number().min(0).max(1),
  canRetry: z.boolean(),
  evaluatedAt: z.string().datetime(),
  deterministicResults: z.array(CheckResultSchema),
  semanticResults: z.array(CheckResultSchema),
  rationale: z.string(),
  signedHash: z.string(),
});

export type ArbitrationVerdict = z.infer<typeof ArbitrationVerdictSchema>;
