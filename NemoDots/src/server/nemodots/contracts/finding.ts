import { z } from 'zod';
import {
  AttemptIdSchema,
  FindingIdSchema,
  IsoTimeSchema,
  MissionIdSchema,
  ReceiptIdSchema,
  TaskIdSchema,
} from './ids.js';
import { DependencyVectorSchema } from './model-call.js';

// CONTRACTS.md section 7: Findings are model claims, never ObservationReceipts.

export const FindingConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type FindingConfidence = z.infer<typeof FindingConfidenceSchema>;
export const FindingClaimSchema = z.string().min(1).max(2000);

export const FindingSchema = z
  .object({
    id: FindingIdSchema,
    missionId: MissionIdSchema,
    taskId: TaskIdSchema,
    attemptId: AttemptIdSchema,
    claim: FindingClaimSchema,
    /** Citations, checked against the same scope rule as section 5. */
    supportingReceiptIds: z.array(ReceiptIdSchema),
    confidence: FindingConfidenceSchema,
    trust: z.literal('model_claim'),
    usable: z.boolean(),
    dependencyVector: DependencyVectorSchema,
    createdAt: IsoTimeSchema,
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;
