import { z } from 'zod';
import { DigestSchema } from './digest.js';
import {
  AttemptIdSchema,
  ContextSnapshotIdSchema,
  CountSchema,
  InvalidationEventIdSchema,
  IsoTimeSchema,
  ModelCallIdSchema,
  ReceiptIdSchema,
  RevisionSchema,
  ScopeSchema,
  SourceKeySchema,
  TaskIdSchema,
} from './ids.js';

// CONTRACTS.md section 3: ModelCallRecord and ContextSnapshot.

export const ModelRoleSchema = z.enum([
  'planner',
  'worker',
  'repair',
  'replan',
  'summarizer',
]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export const ContextLayoutSchema = z.enum(['cache_aware', 'ordinary']);
export type ContextLayout = z.infer<typeof ContextLayoutSchema>;

export const DependencyEntrySchema = z
  .object({
    sourceKey: SourceKeySchema,
    sourceRevision: RevisionSchema,
    receiptId: ReceiptIdSchema,
  })
  .strict();
export type DependencyEntry = z.infer<typeof DependencyEntrySchema>;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Total order: sourceKey, then sourceRevision, then receiptId. */
export function compareDependencyEntries(
  a: DependencyEntry,
  b: DependencyEntry,
): number {
  return (
    compare(a.sourceKey, b.sourceKey) ||
    a.sourceRevision - b.sourceRevision ||
    compare(a.receiptId, b.receiptId)
  );
}

/** Sorted by sourceKey (then revision, receipt id), without duplicate entries. */
export const DependencyVectorSchema = z
  .array(DependencyEntrySchema)
  .refine(
    (vector) =>
      vector.every(
        (entry, i) => i === 0 || compareDependencyEntries(vector[i - 1], entry) < 0,
      ),
    { message: 'dependency vector must be sorted by sourceKey and unique' },
  );
export type DependencyVector = z.infer<typeof DependencyVectorSchema>;

/** Conservative union of vectors: every entry kept, duplicates removed, sorted. */
export function unionDependencyVectors(
  ...vectors: readonly (readonly DependencyEntry[])[]
): DependencyVector {
  const byReceipt = new Map<string, DependencyEntry>();
  for (const vector of vectors)
    for (const entry of vector) {
      const existing = byReceipt.get(entry.receiptId);
      if (
        existing &&
        (existing.sourceKey !== entry.sourceKey ||
          existing.sourceRevision !== entry.sourceRevision)
      )
        throw new RangeError(
          `receipt ${entry.receiptId} appears with two source revisions`,
        );
      byReceipt.set(entry.receiptId, {
        sourceKey: entry.sourceKey,
        sourceRevision: entry.sourceRevision,
        receiptId: entry.receiptId,
      });
    }
  return [...byReceipt.values()].sort(compareDependencyEntries);
}

const injectedReceipt = z
  .object({
    id: ReceiptIdSchema,
    sourceKey: SourceKeySchema,
    sourceRevision: RevisionSchema,
    contentDigest: DigestSchema,
  })
  .strict();

export const ContextSnapshotSchema = z
  .object({
    id: ContextSnapshotIdSchema,
    contextSchemaVersion: z.literal('v1'),
    layout: ContextLayoutSchema,
    prefixDigest: DigestSchema,
    prefixLength: CountSchema,
    contextDigest: DigestSchema,
    contextLength: CountSchema,
    toolSchemaHash: DigestSchema,
    injected: z
      .object({
        receipts: z.array(injectedReceipt),
        inheritedArtifacts: z.array(
          z
            .object({
              kind: z.enum(['task_output', 'handoff', 'summary', 'finding']),
              id: z.string().min(1),
              digest: DigestSchema,
              dependencyReceiptIds: z.array(ReceiptIdSchema),
            })
            .strict(),
        ),
        runbooks: z.array(
          z.object({ id: z.string().min(1), digest: DigestSchema }).strict(),
        ),
        pageSnapshots: z.array(
          z
            .object({
              pageId: z.string().min(1),
              revision: RevisionSchema,
              digest: DigestSchema,
            })
            .strict(),
        ),
        memories: z.array(
          z.object({ id: z.string().min(1), digest: DigestSchema }).strict(),
        ),
        invalidationEvents: z.array(InvalidationEventIdSchema),
        historyItems: z.array(
          z
            .object({
              role: z.enum(['assistant', 'tool', 'user']),
              digest: DigestSchema,
              dependencyReceiptIds: z.array(ReceiptIdSchema),
            })
            .strict(),
        ),
      })
      .strict(),
    dependencyVector: DependencyVectorSchema,
    volatile: z.object({ nowIso: IsoTimeSchema }).strict(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.prefixLength > snapshot.contextLength)
      ctx.addIssue({
        code: 'custom',
        path: ['prefixLength'],
        message: 'prefix cannot be longer than the context',
      });
    // The vector is a conservative union of everything injected.
    const covered = new Set(snapshot.dependencyVector.map((e) => e.receiptId));
    const referenced = [
      ...snapshot.injected.receipts.map((r) => r.id),
      ...snapshot.injected.inheritedArtifacts.flatMap((a) => a.dependencyReceiptIds),
      ...snapshot.injected.historyItems.flatMap((h) => h.dependencyReceiptIds),
    ];
    for (const id of referenced)
      if (!covered.has(id))
        ctx.addIssue({
          code: 'custom',
          path: ['dependencyVector'],
          message: `injected receipt ${id} missing from dependencyVector`,
        });
  });
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

const tokenCount = CountSchema.nullable();
export const UsageSchema = z
  .object({
    promptTokens: tokenCount,
    completionTokens: tokenCount,
    /** null = unavailable (prompt_tokens_details absent or null); 0 only when the provider returned 0. */
    cachedTokens: tokenCount,
    reasoningTokens: tokenCount,
  })
  .strict();
export type Usage = z.infer<typeof UsageSchema>;

export const FinishReasonSchema = z.enum([
  'stop',
  'tool_calls',
  'length',
  'content_filter',
  'cancelled',
  'error',
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;
export const InferenceErrorClassSchema = z.enum([
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'provider_error',
  'network',
  'invalid_response',
  'cancelled',
]);
export type InferenceErrorClass = z.infer<typeof InferenceErrorClassSchema>;
/** Only these error classes are retried, never a mutating tool. */
export const RETRYABLE_INFERENCE_ERRORS = [
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'network',
] as const satisfies readonly InferenceErrorClass[];
export const INFERENCE_RETRY = {
  baseMs: 1000,
  capMs: 30000,
  maxRetries: 4,
} as const;

export const InferenceAttemptSchema = z
  .object({
    n: z.number().int().positive(),
    startedAt: IsoTimeSchema,
    headersAt: IsoTimeSchema.nullable(),
    firstContentAt: IsoTimeSchema.nullable(),
    finishedAt: IsoTimeSchema.nullable(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    usage: UsageSchema,
    finishReason: FinishReasonSchema.nullable(),
    error: z
      .object({
        class: InferenceErrorClassSchema,
        code: z.string().nullable(),
        errorId: z.string().nullable(),
      })
      .strict()
      .nullable(),
    retryAfterMs: CountSchema.nullable(),
    streamed: z.boolean(),
    outcome: z.enum(['recorded', 'orphaned_fence']),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    const cancelled =
      attempt.finishReason === 'cancelled' || attempt.error?.class === 'cancelled';
    if (cancelled && Object.values(attempt.usage).some((v) => v !== null))
      ctx.addIssue({
        code: 'custom',
        path: ['usage'],
        message: 'a cancelled attempt records usage fields as null',
      });
  });
export type InferenceAttempt = z.infer<typeof InferenceAttemptSchema>;

export const ModelCallOutcomeSchema = z.enum([
  'completed',
  'tool_calls',
  'aborted',
  'failed',
  'invalid_output',
]);
export type ModelCallOutcome = z.infer<typeof ModelCallOutcomeSchema>;
export const ProviderModeSchema = z.enum(['live', 'fixture']);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const ModelCallToolCallSchema = z
  .object({
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    argumentsDigest: DigestSchema,
  })
  .strict();

export const ModelCallRecordSchema = z
  .object({
    id: ModelCallIdSchema,
    scope: ScopeSchema,
    taskId: TaskIdSchema,
    attemptId: AttemptIdSchema,
    role: ModelRoleSchema,
    model: z
      .object({ requested: z.string().min(1), returned: z.string().min(1).nullable() })
      .strict(),
    provider: z
      .object({ host: z.string().min(1), mode: ProviderModeSchema })
      .strict(),
    contextSnapshotId: ContextSnapshotIdSchema,
    attempts: z.array(InferenceAttemptSchema).min(1),
    outcome: ModelCallOutcomeSchema,
    outputDigest: DigestSchema.nullable(),
    outputDependencyVector: DependencyVectorSchema,
    toolCalls: z.array(ModelCallToolCallSchema),
    createdAt: IsoTimeSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    const ids = record.toolCalls.map((call) => call.toolCallId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['toolCalls'],
        message: 'tool call ids must be unique within a model call',
      });
    if (record.outcome === 'tool_calls' && ids.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['toolCalls'],
        message: 'outcome tool_calls requires at least one tool call',
      });
  });
export type ModelCallRecord = z.infer<typeof ModelCallRecordSchema>;
