import { z } from 'zod';
import {
  ActionIntentSchema,
  AuthorizationSchema,
  ConfigValueSchema,
  ResultReceiptSchema,
} from './action.js';
import { DigestSchema } from './digest.js';
import { FindingSchema } from './finding.js';
import {
  CountSchema,
  IsoTimeSchema,
  RevisionSchema,
  SourceKeySchema,
} from './ids.js';
import { ModelRoleSchema, ProviderModeSchema } from './model-call.js';
import {
  ObservationReceiptSchema,
  ReceiptConfirmationSchema,
} from './observation.js';
import { InvalidationEventSchema, RecoveryEventSchema } from './recovery.js';
import {
  AdmissionSchema,
  MissionConstraintsSchema,
  MissionGoalSchema,
  MissionSchema,
  TaskAttemptSchema,
  TaskOutputSchema,
  TaskSchema,
} from './task.js';

// CONTRACTS.md section 9: route DTOs under /api/nemodots.

export const NEMODOTS_ROUTE_PREFIX = '/api/nemodots';

export const CHECKOUT_STATUSES = ['ok', 'degraded', 'down'] as const;
export const CheckoutStatusSchema = z.enum(CHECKOUT_STATUSES);
export const ServiceStateSchema = z.enum(['ok', 'down']);

export const HealthStatusSchema = z
  .object({
    mode: z.enum(['live', 'fixture', 'blocked']),
    provider: z
      .object({
        reachable: z.boolean(),
        modelListed: z.boolean(),
        model: z.string().nullable(),
        /** new URL(OPENAI_BASE_URL).host; null when the base URL is missing. */
        host: z.string().nullable(),
        checkedAt: IsoTimeSchema.nullable(),
      })
      .strict(),
    postgres: ServiceStateSchema,
    redis: ServiceStateSchema,
    checkout: z
      .object({
        reachable: z.boolean(),
        status: CheckoutStatusSchema.nullable(),
      })
      .strict(),
    intelligence: z.enum(['configured', 'blocked']),
    /** names only, never values */
    missingEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
    incidentDotIds: CountSchema,
  })
  .strict();
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const CreateMissionRequestSchema = z
  .object({
    goal: MissionGoalSchema,
    constraints: MissionConstraintsSchema.optional(),
    /** must equal the server-resolved mode (I11) */
    mode: ProviderModeSchema.optional(),
    admission: AdmissionSchema.optional(),
  })
  .strict();
export type CreateMissionRequest = z.infer<typeof CreateMissionRequestSchema>;

export const ErrorResponseSchema = z
  .object({ error: z.string().min(1) })
  .strict();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export const BlockedResponseSchema = z
  .object({ error: z.string().min(1), missingEnv: z.array(z.string()) })
  .strict();
export type BlockedResponse = z.infer<typeof BlockedResponseSchema>;

export const LifecycleRequestSchema = z.object({}).strict();
export const MissionLifecycleActionSchema = z.enum([
  'start',
  'pause',
  'resume',
  'cancel',
]);
export type MissionLifecycleAction = z.infer<
  typeof MissionLifecycleActionSchema
>;

export const TelemetrySummarySchema = z
  .object({
    calls: CountSchema,
    orphanedCalls: CountSchema,
    tokens: z
      .object({
        prompt: CountSchema,
        completion: CountSchema,
        cached: z
          .object({ available: z.boolean(), total: CountSchema.nullable() })
          .strict()
          .refine((cached) => cached.available === (cached.total !== null), {
            message: 'cached.total is null exactly when unavailable',
          }),
      })
      .strict(),
    byModel: z.array(
      z
        .object({
          model: z.string().min(1),
          calls: CountSchema,
          promptTokens: CountSchema,
          completionTokens: CountSchema,
          cachedTokens: CountSchema.nullable(),
        })
        .strict(),
    ),
    byRole: z.array(
      z
        .object({
          role: ModelRoleSchema,
          calls: CountSchema,
          promptTokens: CountSchema,
          completionTokens: CountSchema,
        })
        .strict(),
    ),
    retries: CountSchema,
    errors: CountSchema,
    ttftMs: z
      .object({ p50: z.number().nonnegative(), p95: z.number().nonnegative() })
      .strict()
      .nullable(),
    prefixGroups: z.array(
      z.object({ prefixDigest: DigestSchema, calls: CountSchema }).strict(),
    ),
  })
  .strict();
export type TelemetrySummary = z.infer<typeof TelemetrySummarySchema>;

export const MissionSnapshotSchema = z
  .object({
    mission: MissionSchema,
    tasks: z.array(TaskSchema),
    attempts: z.array(TaskAttemptSchema),
    outputs: z.array(TaskOutputSchema),
    findings: z.array(FindingSchema),
    receipts: z.array(ObservationReceiptSchema),
    confirmations: z.array(ReceiptConfirmationSchema),
    actions: z.array(ActionIntentSchema),
    authorizations: z.array(AuthorizationSchema),
    results: z.array(ResultReceiptSchema),
    /** perMission subset only */
    invalidations: z.array(InvalidationEventSchema),
    recoveries: z.array(RecoveryEventSchema),
    /** latest checkout.acceptance receipt, if any */
    probe: ObservationReceiptSchema.nullable(),
    telemetry: TelemetrySummarySchema,
    /** 0 when no event exists */
    lastEventId: CountSchema,
  })
  .strict();
export type MissionSnapshot = z.infer<typeof MissionSnapshotSchema>;

export const SourceEditRequestSchema = z
  .object({ value: ConfigValueSchema, expectedVersion: RevisionSchema })
  .strict();
export type SourceEditRequest = z.infer<typeof SourceEditRequestSchema>;
export const SourceEditResponseSchema = z
  .object({ key: SourceKeySchema, version: RevisionSchema })
  .strict();
export type SourceEditResponse = z.infer<typeof SourceEditResponseSchema>;

export const InjectorRunRequestSchema = z
  .object({ scenarioClass: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) })
  .strict();
export type InjectorRunRequest = z.infer<typeof InjectorRunRequestSchema>;
export const InjectorRunResponseSchema = z
  .object({ runId: z.string().min(1) })
  .strict();
export type InjectorRunResponse = z.infer<typeof InjectorRunResponseSchema>;

/** Proxied checkout /health (ARCHITECTURE 9.1, 9.4) plus sampledAt. */
export const CheckoutHealthResponseSchema = z
  .object({
    status: CheckoutStatusSchema,
    postgres: z.boolean(),
    redis: z.boolean(),
    config_parse: z.boolean(),
    writes: z.boolean(),
    errorClasses: z.array(z.string()),
    sampledAt: IsoTimeSchema,
  })
  .strict();
export type CheckoutHealthResponse = z.infer<
  typeof CheckoutHealthResponseSchema
>;

export const EvalsReportResponseSchema = z.union([
  z.object({ status: z.literal('NOT_RUN') }).strict(),
  z
    .object({
      status: z.enum(['PASS', 'FAIL', 'BLOCKED']),
      generatedAt: IsoTimeSchema,
      summary: z.unknown(),
    })
    .strict(),
]);
export type EvalsReportResponse = z.infer<typeof EvalsReportResponseSchema>;

/** Route table (method, path relative to NEMODOTS_ROUTE_PREFIX). */
export const NEMODOTS_ROUTES = Object.freeze([
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/missions' },
  { method: 'GET', path: '/missions' },
  { method: 'GET', path: '/missions/:id' },
  { method: 'POST', path: '/missions/:id/start' },
  { method: 'POST', path: '/missions/:id/pause' },
  { method: 'POST', path: '/missions/:id/resume' },
  { method: 'POST', path: '/missions/:id/cancel' },
  { method: 'GET', path: '/missions/:id/events' },
  { method: 'GET', path: '/missions/:id/tasks' },
  { method: 'GET', path: '/missions/:id/evidence' },
  { method: 'GET', path: '/missions/:id/actions' },
  { method: 'GET', path: '/missions/:id/recovery' },
  { method: 'GET', path: '/missions/:id/telemetry' },
  { method: 'POST', path: '/sandbox/sources/:key' },
  { method: 'POST', path: '/sandbox/injector/run' },
  { method: 'GET', path: '/sandbox/checkout/health' },
  { method: 'GET', path: '/telemetry/summary' },
  { method: 'GET', path: '/evals/report' },
] as const);
