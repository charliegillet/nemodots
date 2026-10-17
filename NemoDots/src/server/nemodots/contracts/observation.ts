import { z } from 'zod';
import { boundedCanonical, DigestSchema } from './digest.js';
import {
  ActionIdSchema,
  AttemptIdSchema,
  IsoTimeSchema,
  ModelCallIdSchema,
  ReceiptIdSchema,
  RevisionSchema,
  SourceRefSchema,
} from './ids.js';

// CONTRACTS.md section 2: ObservationReceipt and confirmations.

export const NORMALIZED_VALUE_MAX_BYTES = 16 * 1024;

export const ReceiptStatusSchema = z.enum([
  'supported',
  'superseded',
  'contested',
  'retracted',
  'expired',
]);
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;

export const TrustClassSchema = z.enum([
  'controlled_authority',
  'probe',
  'observed_tool',
  'page_snapshot',
  'memory_snapshot',
  'runbook',
  'model_claim',
]);
export type TrustClass = z.infer<typeof TrustClassSchema>;
/** model_claim never appears on an ObservationReceipt; Finding reuses the enum. */
export const ReceiptTrustClassSchema = TrustClassSchema.exclude(['model_claim']);

export const TransitionReasonSchema = z.enum([
  'newer_observation',
  'conflicting_observation',
  'owner_retraction',
  'ttl_elapsed',
  'source_removed',
  'resolved',
]);
export type TransitionReason = z.infer<typeof TransitionReasonSchema>;

export const ProvenanceKindSchema = z.enum([
  'watcher',
  'tool_call',
  'probe',
  'commit_postcondition',
  'owner_edit',
]);
export const SelfWriteSchema = z.enum(['none', 'verified', 'mismatch']);
export type SelfWrite = z.infer<typeof SelfWriteSchema>;

/** normalizedValue of the `checkout.config` membership collection (rev2 C1/D1). */
export const CollectionValueSchema = z
  .object({
    keys: z.array(z.string().min(1)),
    collectionVersion: RevisionSchema,
  })
  .strict()
  .refine(
    (value) => value.keys.every((key, i) => i === 0 || value.keys[i - 1] < key),
    { message: 'keys must be sorted and unique', path: ['keys'] },
  );
export type CollectionValue = z.infer<typeof CollectionValueSchema>;

export const RawRefSchema = z
  .object({
    kind: z.enum(['inline', 'blob']),
    digest: DigestSchema,
    bytes: z.number().int().nonnegative(),
    id: z.string().min(1).nullable(),
  })
  .strict();

export const ObservationReceiptSchema = z
  .object({
    id: ReceiptIdSchema,
    source: SourceRefSchema,
    sourceRevision: RevisionSchema,
    collectionRevision: RevisionSchema.nullable(),
    observedAt: IsoTimeSchema,
    lastConfirmedAt: IsoTimeSchema,
    contentDigest: DigestSchema,
    normalizedValue: z
      .unknown()
      .superRefine(boundedCanonical(NORMALIZED_VALUE_MAX_BYTES)),
    rawRef: RawRefSchema.nullable(),
    status: ReceiptStatusSchema,
    statusVersion: RevisionSchema,
    supersedes: ReceiptIdSchema.nullable(),
    supersededBy: ReceiptIdSchema.nullable(),
    trust: ReceiptTrustClassSchema,
    provenance: z
      .object({
        kind: ProvenanceKindSchema,
        toolCallId: z.string().min(1).nullable(),
        modelCallId: ModelCallIdSchema.nullable(),
        attemptId: AttemptIdSchema.nullable(),
        causedByActionId: ActionIdSchema.nullable(),
        selfWrite: SelfWriteSchema,
      })
      .strict(),
    negative: z
      .object({ predicate: z.string().min(1), collectionRevision: RevisionSchema })
      .strict()
      .nullable(),
    expiresAt: IsoTimeSchema.nullable(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (Date.parse(receipt.lastConfirmedAt) < Date.parse(receipt.observedAt))
      ctx.addIssue({
        code: 'custom',
        path: ['lastConfirmedAt'],
        message: 'lastConfirmedAt must not precede observedAt',
      });
    if (
      receipt.source.sourceType === 'controlled_collection' &&
      !CollectionValueSchema.safeParse(receipt.normalizedValue).success
    )
      ctx.addIssue({
        code: 'custom',
        path: ['normalizedValue'],
        message: 'collection value must be { keys: sorted string[], collectionVersion }',
      });
    if (receipt.supersedes !== null && receipt.supersedes === receipt.id)
      ctx.addIssue({
        code: 'custom',
        path: ['supersedes'],
        message: 'a receipt cannot supersede itself',
      });
  });
export type ObservationReceipt = z.infer<typeof ObservationReceiptSchema>;

/** (rev2 I2/D3) append-only; advances the receipt's lastConfirmedAt. */
export const ReceiptConfirmationSchema = z
  .object({
    receiptId: ReceiptIdSchema,
    confirmedAt: IsoTimeSchema,
    provenance: z
      .object({
        kind: z.enum(['watcher', 'tool_call', 'probe']),
        attemptId: AttemptIdSchema.nullable(),
        modelCallId: ModelCallIdSchema.nullable(),
      })
      .strict(),
  })
  .strict();
export type ReceiptConfirmation = z.infer<typeof ReceiptConfirmationSchema>;

export const ReceiptTransitionSchema = z
  .object({
    receiptId: ReceiptIdSchema,
    from: ReceiptStatusSchema,
    to: ReceiptStatusSchema,
    reason: TransitionReasonSchema,
    at: IsoTimeSchema,
    eventId: z.string().min(1),
  })
  .strict();
export type ReceiptTransition = z.infer<typeof ReceiptTransitionSchema>;

/** Freshness for a policy entry: lastConfirmedAt >= now - maxAgeMs. */
export function isFresh(
  receipt: Pick<ObservationReceipt, 'lastConfirmedAt'>,
  maxAgeMs: number,
  nowMs: number,
): boolean {
  return Date.parse(receipt.lastConfirmedAt) >= nowMs - maxAgeMs;
}
