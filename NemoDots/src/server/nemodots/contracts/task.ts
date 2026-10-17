import { z } from 'zod';
import { boundedCanonical, DigestSchema } from './digest.js';
import {
  ActionIdSchema,
  AttemptIdSchema,
  CountSchema,
  DependencyEdgeIdSchema,
  InvalidationEventIdSchema,
  IsoTimeSchema,
  MissionIdSchema,
  ModelCallIdSchema,
  ReceiptIdSchema,
  ScopeSchema,
  TaskIdSchema,
  TaskOutputIdSchema,
} from './ids.js';
import { DependencyVectorSchema, ProviderModeSchema } from './model-call.js';

// CONTRACTS.md section 4: Mission, Task, TaskAttempt, DependencyEdge, Lease.

export const MissionStatusSchema = z.enum([
  'created',
  'blocked_provider',
  'running',
  'paused',
  'awaiting_acceptance',
  'succeeded',
  'failed',
  'cancelled',
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const MISSION_ADMISSION_MIN_AGE_MAX_MS = 60000;
export const AdmissionSchema = z
  .object({
    minAgeMs: z.number().int().min(0).max(MISSION_ADMISSION_MIN_AGE_MAX_MS),
  })
  .strict();

const positive = z.number().int().positive();
export const MissionBudgetsSchema = z
  .object({
    maxTasks: positive,
    maxDepth: positive,
    maxBreadth: positive,
    maxTokens: positive,
    maxInferenceCalls: positive,
    maxWallClockMs: positive,
  })
  .strict();

export const MissionGoalSchema = z.string().min(1).max(2000);
export const MissionConstraintsSchema = z.array(z.string().min(1).max(500)).max(20);

export const MissionSchema = z
  .object({
    id: MissionIdSchema,
    scope: ScopeSchema,
    goal: MissionGoalSchema,
    constraints: MissionConstraintsSchema,
    mode: ProviderModeSchema,
    status: MissionStatusSchema,
    transitionVersion: CountSchema,
    generation: CountSchema,
    budgets: MissionBudgetsSchema,
    admission: AdmissionSchema,
    provider: z
      .object({
        host: z.string().min(1),
        plannerModel: z.string().min(1),
        workerModel: z.string().min(1),
      })
      .strict(),
    acceptanceReceiptId: ReceiptIdSchema.nullable(),
    failureReason: z.string().nullable(),
    cancellation: z
      .object({
        requestedAt: IsoTimeSchema,
        abortedAttemptIds: z.array(AttemptIdSchema),
        cancelledIntentIds: z.array(ActionIdSchema),
        committedEffects: z.array(ActionIdSchema),
      })
      .strict()
      .nullable(),
    createdAt: IsoTimeSchema,
    startedAt: IsoTimeSchema.nullable(),
    finishedAt: IsoTimeSchema.nullable(),
  })
  .strict()
  .superRefine((mission, ctx) => {
    if (mission.scope.missionId !== mission.id)
      ctx.addIssue({
        code: 'custom',
        path: ['scope', 'missionId'],
        message: 'scope.missionId must equal the mission id',
      });
  });
export type Mission = z.infer<typeof MissionSchema>;

export const TaskStatusSchema = z.enum([
  'pending',
  'runnable',
  'leased',
  'running',
  'waiting',
  'succeeded',
  'invalidated',
  'repairing',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskRoleSchema = z.enum([
  'planner',
  'investigator',
  'cache_specialist',
  'database_specialist',
  'routing_specialist',
  'verifier',
  'postcondition',
]);
export type TaskRole = z.infer<typeof TaskRoleSchema>;

export const CapabilitySchema = z.enum([
  'observe',
  'delegate',
  'propose_config_change',
  'propose_cache_flush',
  'publish_finding',
  'request_replan',
]);
export type Capability = z.infer<typeof CapabilitySchema>;

/** (rev2 D5) capability sets that make delegation structurally necessary. */
export const ROLE_CAPABILITIES = Object.freeze({
  planner: Object.freeze([]),
  investigator: Object.freeze([
    'observe',
    'delegate',
    'publish_finding',
    'request_replan',
  ]),
  cache_specialist: Object.freeze([
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
    'propose_cache_flush',
  ]),
  database_specialist: Object.freeze([
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
  ]),
  routing_specialist: Object.freeze([
    'observe',
    'delegate',
    'publish_finding',
    'propose_config_change',
  ]),
  verifier: Object.freeze(['observe', 'publish_finding']),
  postcondition: Object.freeze(['observe', 'publish_finding']),
} as const satisfies Record<TaskRole, readonly Capability[]>);

const SPECIALIST_ROLES: readonly TaskRole[] = [
  'cache_specialist',
  'database_specialist',
  'routing_specialist',
];

/** Roles a task of `parentRole` may delegate to. Specialists delegate only 'verifier'. */
export function delegableRoles(parentRole: TaskRole): readonly TaskRole[] {
  if (!(ROLE_CAPABILITIES[parentRole] as readonly Capability[]).includes('delegate'))
    return [];
  if (SPECIALIST_ROLES.includes(parentRole)) return ['verifier'];
  return ['investigator', ...SPECIALIST_ROLES, 'verifier'];
}

/** A task's capabilities ⊆ ROLE_CAPABILITIES[role] ∩ parent.capabilities. */
export function allowedCapabilities(
  role: TaskRole,
  parentCapabilities: readonly Capability[] | null,
): Capability[] {
  const defaults = ROLE_CAPABILITIES[role] as readonly Capability[];
  return parentCapabilities === null
    ? [...defaults]
    : defaults.filter((capability) => parentCapabilities.includes(capability));
}

export function capabilitiesWithinRole(
  role: TaskRole,
  capabilities: readonly Capability[],
): boolean {
  const defaults = ROLE_CAPABILITIES[role] as readonly Capability[];
  return capabilities.every((capability) => defaults.includes(capability));
}

const uniqueCapabilities = z
  .array(CapabilitySchema)
  .refine((list) => new Set(list).size === list.length, {
    message: 'capabilities must be unique',
  });

export const TaskTitleSchema = z.string().min(1).max(160);
export const TaskQuestionSchema = z.string().min(1).max(2000);
export const TaskJustificationSchema = z.string().min(1).max(500);

export const TaskObjectSchema = z
  .object({
    id: TaskIdSchema,
    missionId: MissionIdSchema,
    parentId: TaskIdSchema.nullable(),
    depth: CountSchema,
    ordinal: CountSchema,
    title: TaskTitleSchema,
    question: TaskQuestionSchema,
    role: TaskRoleSchema,
    capabilities: uniqueCapabilities,
    status: TaskStatusSchema,
    transitionVersion: CountSchema,
    generation: CountSchema,
    prerequisites: z.array(TaskIdSchema),
    fenceSeq: CountSchema,
    attemptCount: CountSchema,
    maxAttempts: z.number().int().positive(),
    budget: z
      .object({
        maxIterations: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
        maxChildren: CountSchema,
      })
      .strict(),
    outputId: TaskOutputIdSchema.nullable(),
    createdByModelCallId: ModelCallIdSchema.nullable(),
    justification: TaskJustificationSchema.nullable(),
    createdAt: IsoTimeSchema,
    finishedAt: IsoTimeSchema.nullable(),
  })
  .strict();

export const TASK_DEFAULT_MAX_ATTEMPTS = 3;

export const TaskSchema = TaskObjectSchema.superRefine((task, ctx) => {
  if (!capabilitiesWithinRole(task.role, task.capabilities))
    ctx.addIssue({
      code: 'custom',
      path: ['capabilities'],
      message: `capabilities exceed ROLE_CAPABILITIES.${task.role}`,
    });
  if (task.parentId !== null && task.justification === null)
    ctx.addIssue({
      code: 'custom',
      path: ['justification'],
      message: 'justification is required for delegated tasks',
    });
  if ((task.parentId === null) !== (task.depth === 0))
    ctx.addIssue({
      code: 'custom',
      path: ['depth'],
      message: 'depth is 0 exactly for root tasks',
    });
  if (task.prerequisites.includes(task.id))
    ctx.addIssue({
      code: 'custom',
      path: ['prerequisites'],
      message: 'a task cannot be its own prerequisite',
    });
});
export type Task = z.infer<typeof TaskSchema>;

export const AttemptStatusSchema = z.enum([
  'running',
  'published',
  'failed',
  'aborted',
  'expired',
  'invalidated',
]);
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>;
export const AttemptKindSchema = z.enum([
  'initial',
  'retry',
  'repair',
  'replan',
  'postcondition',
]);
export type AttemptKind = z.infer<typeof AttemptKindSchema>;
export const AbortReasonSchema = z.enum([
  'readset_invalidated',
  'mission_paused',
  'mission_cancelled',
  'lease_lost',
  'budget_exhausted',
  'provider_unreachable',
  'publication_rejected',
]);
export type AbortReason = z.infer<typeof AbortReasonSchema>;

export const LeaseSchema = z
  .object({
    owner: z.string().min(1),
    fencingToken: CountSchema,
    expiresAt: IsoTimeSchema,
    renewedAt: IsoTimeSchema,
  })
  .strict();
export type Lease = z.infer<typeof LeaseSchema>;

export const RepairOfSchema = z
  .object({
    attemptId: AttemptIdSchema,
    invalidationEventId: InvalidationEventIdSchema,
  })
  .strict();

export const TaskAttemptSchema = z
  .object({
    id: AttemptIdSchema,
    taskId: TaskIdSchema,
    missionId: MissionIdSchema,
    n: z.number().int().positive(),
    kind: AttemptKindSchema,
    status: AttemptStatusSchema,
    generation: CountSchema,
    lease: LeaseSchema,
    readSetReceiptIds: z.array(ReceiptIdSchema),
    modelCallIds: z.array(ModelCallIdSchema),
    inheritedDependencyVector: DependencyVectorSchema,
    repairOf: RepairOfSchema.nullable(),
    abortReason: AbortReasonSchema.nullable(),
    startedAt: IsoTimeSchema,
    finishedAt: IsoTimeSchema.nullable(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.kind === 'repair' && attempt.repairOf === null)
      ctx.addIssue({
        code: 'custom',
        path: ['repairOf'],
        message: 'a repair attempt records what it repairs',
      });
    if (attempt.status === 'aborted' && attempt.abortReason === null)
      ctx.addIssue({
        code: 'custom',
        path: ['abortReason'],
        message: 'an aborted attempt records its abortReason',
      });
    if (attempt.status === 'running' && attempt.abortReason !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['abortReason'],
        message: 'a running attempt has no abortReason',
      });
  });
export type TaskAttempt = z.infer<typeof TaskAttemptSchema>;

export const TASK_OUTPUT_MAX_BYTES = 32 * 1024;
export const TaskOutputKindSchema = z.enum([
  'finding',
  'handoff',
  'plan',
  'verification',
]);
export type TaskOutputKind = z.infer<typeof TaskOutputKindSchema>;

export const TaskOutputSchema = z
  .object({
    id: TaskOutputIdSchema,
    taskId: TaskIdSchema,
    attemptId: AttemptIdSchema,
    kind: TaskOutputKindSchema,
    content: z.unknown().superRefine(boundedCanonical(TASK_OUTPUT_MAX_BYTES)),
    digest: DigestSchema,
    dependencyVector: DependencyVectorSchema,
    usable: z.boolean(),
    unusableReason: z.string().min(1).nullable(),
    publishedAt: IsoTimeSchema,
  })
  .strict()
  .refine((output) => output.usable === (output.unusableReason === null), {
    path: ['unusableReason'],
    message: 'unusableReason is set exactly when the output is unusable',
  });
export type TaskOutput = z.infer<typeof TaskOutputSchema>;

export const EdgeKindSchema = z.enum(['evidence', 'inheritance', 'scheduling']);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const DependencyEdgeSchema = z
  .object({
    id: DependencyEdgeIdSchema,
    missionId: MissionIdSchema,
    kind: EdgeKindSchema,
    from: z
      .object({
        kind: z.enum([
          'receipt',
          'model_call',
          'attempt',
          'task_output',
          'task',
          'action_intent',
        ]),
        id: z.string().min(1),
      })
      .strict(),
    to: z
      .object({
        kind: z.enum(['model_call', 'attempt', 'task_output', 'task', 'action_intent']),
        id: z.string().min(1),
      })
      .strict(),
    createdAt: IsoTimeSchema,
  })
  .strict();
export type DependencyEdge = z.infer<typeof DependencyEdgeSchema>;

/** Plan emitted by the Nemotron planner (strict json_schema); 2..6 root tasks. */
export const PlanTaskSchema = z
  .object({
    title: TaskTitleSchema,
    question: TaskQuestionSchema,
    role: TaskRoleSchema,
    capabilities: z.array(CapabilitySchema),
    dependsOn: z.array(z.number().int().nonnegative()),
  })
  .strict();
export const PlanSchema = z
  .object({ tasks: z.array(PlanTaskSchema).min(2).max(6) })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

/** Created by the coordinator and passed to tools as context.context; nothing comes from the model. */
export const AttemptContextSchema = z
  .object({
    missionId: MissionIdSchema,
    taskId: TaskIdSchema,
    attemptId: AttemptIdSchema,
    fencingToken: CountSchema,
    generation: CountSchema,
    capabilities: uniqueCapabilities,
    role: TaskRoleSchema,
  })
  .strict()
  .refine((context) => capabilitiesWithinRole(context.role, context.capabilities), {
    path: ['capabilities'],
    message: 'capabilities exceed the role',
  });
export type AttemptContext = z.infer<typeof AttemptContextSchema>;
