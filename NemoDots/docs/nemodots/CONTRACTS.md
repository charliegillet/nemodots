# NemoDots contracts v1 (revision 2 after adversarial review)

`CONTRACT_VERSION = 'v1'`. Source of truth once implemented: `src/server/nemodots/contracts/*.ts` (Zod 4 schemas; TypeScript types are `z.infer`). This document is the reviewed specification the wave-1 contracts package implements verbatim. Later packages import and never edit; a contract revision is a separate reviewed package with before/after rationale. Changes from revision 1 are marked **(rev2)** and map to the finding ids in `ARCHITECTURE.md` section 14.

Conventions: ids are UUIDv4 strings (branded types in TS); times are ISO-8601 UTC strings in DTOs and `timestamptz` in PostgreSQL; digests are lowercase hex SHA-256 of canonical JSON (keys sorted, no whitespace, strings NFC, numbers as shortest round-trip, `undefined` omitted); every schema is `.strict()`. Enums are closed; "unknown" variants are explicit members where fail-closed behaviour needs them.

---

## 1. Identity and scope

```ts
Scope = {
  ownerId: string, // OpenDots OWNER_ID (single owner today)
  missionId: MissionId,
  spaceId: string | null,
  environment: 'dev' | 'test' | 'eval',
  resource: string, // e.g. 'checkout'
};
```

Source keys (registry-validated): `checkout.config` (membership collection: **which keys exist**, rev2 C1), `checkout.config/<key>` (member; `<key>` matches `^[a-z][a-z0-9_.]{0,60}$`), `checkout.health`, `checkout.metrics`, `checkout.inventory/<sku>`, `checkout.orders.recent`, `checkout.acceptance`, `redis.stats`, `runbook/<id>`, `opendots.page/<pageId>`, `opendots.memory/<memoryId>`.

```ts
SourceRef = {
  key: SourceKey,
  sourceType:
    'controlled_config' |
    'controlled_collection' |
    'observed_endpoint' |
    'observed_store' |
    'probe' |
    'runbook' |
    'page_snapshot' |
    'memory_snapshot',
  authority: 'controlled' | 'observed', // controlled: version in checkout.config_entries / config_collection ; observed: ledger-assigned
  scope: Scope,
};
```

Collision rule: `(scope.ownerId, scope.environment, scope.resource, key)` is the uniqueness key of a source.

**Revision 3 (2026-10-18, lead ruling on verifier finding F4b):** the uniqueness key of a source is `(scope.ownerId, scope.environment, scope.spaceId, scope.resource, key)`, with a null `spaceId` treated as one value (`UNIQUE NULLS NOT DISTINCT`). Reason: TEST_PROMPT gate 1 #2 and the build prompt's owner/Space isolation require that the same key in different Spaces never collides or supersedes across Spaces; revision 2 omitted `spaceId`. Implemented by migration `0007_source_space` (0002 is already applied and is not edited). Controlled sources in different Spaces still read the same `checkout.config_entries` authority version; each Space's source gets its own receipts. A receipt supports work only in a mission whose owner, environment, Space and resource all match (finding F4). `SupportValidator.assertCurrent` therefore takes a **required** `missionId` (`contracts/ports.ts`): an optional id would let a caller skip the scope check, which fails open. `recordModelCall` refuses inherited outputs from another mission.

**Revision 3 (2026-10-18, D5 delegation, approved by the user):** `allowedCapabilities(role, parentCapabilities)` is `ROLE_CAPABILITIES[role] ∩ parentCapabilities`, plus one server-owned grant: a specialist delegated by a parent holding `delegate` keeps its role's `propose_*` capabilities. Revision 2's pure intersection made the documented investigator → specialist repair path impossible (an investigator cannot propose, so its specialist child could not either). The grant is limited: only investigators may delegate specialists (`delegableRoles`), specialists delegate verifiers only, and admission still checks every proposal's evidence and policy.

The collection's `normalizedValue` is `{ keys: string[] /* sorted */, collectionVersion: number }`; its version advances only on key insert/delete. Member values never affect the collection version (rev2 C1/D1).

---

## 2. ObservationReceipt and confirmations

```ts
ReceiptStatus = 'supported' | 'superseded' | 'contested' | 'retracted' | 'expired'
TrustClass    = 'controlled_authority' | 'probe' | 'observed_tool' | 'page_snapshot' | 'memory_snapshot' | 'runbook' | 'model_claim'
// model_claim never appears on an ObservationReceipt; Finding reuses the enum.

ObservationReceipt = {
  id: ReceiptId,                     // immutable
  source: SourceRef,
  sourceRevision: number,            // controlled: config_entries.version / config_collection.version ; observed: ledger-assigned, monotonic per source
  collectionRevision: number | null, // member observations carry the collection version they were read under
  observedAt: string,
  lastConfirmedAt: string,           // (rev2 I2/D3) == observedAt at creation; advanced by confirmations (derived from receipt_confirmations, exposed in DTOs)
  contentDigest: string,
  normalizedValue: unknown,          // typed, bounded (<= 16 KiB canonical); ARCHITECTURE section 9.4 defines normalization per source
  rawRef: { kind: 'inline' | 'blob'; digest: string; bytes: number; id: string | null } | null,
  status: ReceiptStatus,
  statusVersion: number,
  supersedes: ReceiptId | null,
  supersededBy: ReceiptId | null,
  trust: TrustClass,
  provenance: {
    kind: 'watcher' | 'tool_call' | 'probe' | 'commit_postcondition' | 'owner_edit',
    toolCallId: string | null,
    modelCallId: ModelCallId | null,
    attemptId: AttemptId | null,
    causedByActionId: ActionId | null,   // server-authored only; null for injector/owner/external
    selfWrite: 'none' | 'verified' | 'mismatch',   // (rev2 C7) derived from the LAST config_versions row in the observed range
  },
  negative: { predicate: string; collectionRevision: number } | null,   // membership predicates only, e.g. "key 'x' does not exist" (rev2 D1)
  expiresAt: string | null,
}

ReceiptConfirmation = { receiptId: ReceiptId, confirmedAt: string, provenance: { kind: 'watcher' | 'tool_call' | 'probe'; attemptId: AttemptId | null; modelCallId: ModelCallId | null } }   // (rev2) append-only

ReceiptTransition = { receiptId, from: ReceiptStatus, to: ReceiptStatus, reason: TransitionReason, at, eventId: string }
TransitionReason  = 'newer_observation' | 'conflicting_observation' | 'owner_retraction' | 'ttl_elapsed' | 'source_removed' | 'resolved'
```

Allowed transitions: `supported→superseded|contested|retracted|expired`; `contested→supported|retracted`. A receipt is **current** iff `status='supported'` and, for controlled sources, `sourceRevision` equals the live version at check time. A receipt is **fresh** for a policy entry iff `lastConfirmedAt >= now - maxAgeMs`.

Registration rules (rev2 C8): `registerObservation` locks the `ledger.sources` row `FOR UPDATE` first. Controlled: revision = authority version read in the same transaction; a lower revision than the current receipt's is refused (`stale_observation_rejected`); a returning value (A→B→A) still gets a new revision because the version column only increases. Observed: same digest as the current receipt → append a `ReceiptConfirmation`, return the current receipt, mint nothing; different digest → revision `current+1`, supersede, closure. Old receipts never regain `supported`.

---

## 3. ModelCallRecord and ContextSnapshot

```ts
ModelRole     = 'planner' | 'worker' | 'repair' | 'replan' | 'summarizer'
ContextLayout = 'cache_aware' | 'ordinary'

ContextSnapshot = {
  id: ContextSnapshotId, contextSchemaVersion: 'v1', layout: ContextLayout,
  prefixDigest: string, prefixLength: number,      // first three layout sections
  contextDigest: string, contextLength: number,
  toolSchemaHash: string,
  injected: {
    receipts: { id: ReceiptId; sourceKey: SourceKey; sourceRevision: number; contentDigest: string }[],
    inheritedArtifacts: { kind: 'task_output' | 'handoff' | 'summary' | 'finding'; id: string; digest: string; dependencyReceiptIds: ReceiptId[] }[],
    runbooks: { id: string; digest: string }[],
    pageSnapshots: { pageId: string; revision: number; digest: string }[],
    memories: { id: string; digest: string }[],
    invalidationEvents: InvalidationEventId[],
    historyItems: { role: 'assistant' | 'tool' | 'user'; digest: string; dependencyReceiptIds: ReceiptId[] }[],
  },
  dependencyVector: DependencyVector,              // conservative union of everything above, sorted by sourceKey
  volatile: { nowIso: string },                    // excluded from prefixDigest
}
DependencyVector = { sourceKey: SourceKey; sourceRevision: number; receiptId: ReceiptId }[]

ModelCallRecord = {
  id: ModelCallId,                 // == X-Request-Id
  scope: Scope, taskId: TaskId, attemptId: AttemptId, role: ModelRole,
  model: { requested: string; returned: string | null },
  provider: { host: string /* == new URL(OPENAI_BASE_URL).host */; mode: 'live' | 'fixture' },
  contextSnapshotId: ContextSnapshotId,
  attempts: InferenceAttempt[],
  outcome: 'completed' | 'tool_calls' | 'aborted' | 'failed' | 'invalid_output',
  outputDigest: string | null,
  outputDependencyVector: DependencyVector,       // >= input vector; citations add, never remove
  toolCalls: { toolCallId: string; name: string; argumentsDigest: string }[],   // (rev2 C5/C10) ids of emitted tool calls, used by idempotency and propose
  createdAt: string,
}

InferenceAttempt = {
  n: number, startedAt: string, headersAt: string | null, firstContentAt: string | null, finishedAt: string | null,
  httpStatus: number | null,
  usage: { promptTokens: number | null; completionTokens: number | null; cachedTokens: number | null /* null = unavailable */; reasoningTokens: number | null },
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'cancelled' | 'error' | null,
  error: { class: 'rate_limited' | 'provider_unavailable' | 'timeout' | 'provider_error' | 'network' | 'invalid_response' | 'cancelled'; code: string | null; errorId: string | null } | null,
  retryAfterMs: number | null, streamed: boolean,
  outcome: 'recorded' | 'orphaned_fence',          // (rev2 C16) orphaned: completed after the author's fence was lost; stored unfenced, no edges
}
```

Rules: a cancelled attempt records `usage` fields as `null`. `cachedTokens` is `null` when `prompt_tokens_details` is absent or null, `0` only when the provider returned `0`. Inference retries only on `rate_limited | provider_unavailable | timeout | network` with jittered exponential backoff (base 1 s, cap 30 s, max 4), at most `NEMODOTS_INFERENCE_MAX_IN_FLIGHT` per model; a mutating tool is never retried automatically.

---

## 4. Mission, Task, TaskAttempt, DependencyEdge, Lease

```ts
MissionStatus = 'created' | 'blocked_provider' | 'running' | 'paused' | 'awaiting_acceptance' | 'succeeded' | 'failed' | 'cancelled'
Mission = {
  id: MissionId, scope: Scope, goal: string (<= 2000), constraints: string[] (<= 20, each <= 500),
  mode: 'live' | 'fixture',                        // (rev2 I11) always server-resolved
  status: MissionStatus, transitionVersion: number, generation: number,
  budgets: { maxTasks; maxDepth; maxBreadth; maxTokens; maxInferenceCalls; maxWallClockMs },
  admission: { minAgeMs: number /* 0..60000, default 0 */ },   // (rev2 D6) visible knob: earliest admission after proposal
  provider: { host: string; plannerModel: string; workerModel: string },
  acceptanceReceiptId: ReceiptId | null, failureReason: string | null,
  cancellation: { requestedAt: string; abortedAttemptIds: AttemptId[]; cancelledIntentIds: ActionId[]; committedEffects: ActionId[] } | null,   // (rev2 C12)
  createdAt, startedAt, finishedAt
}
Allowed: created→running|blocked_provider|cancelled ; blocked_provider→created|cancelled ; running→paused|awaiting_acceptance|failed|cancelled ;
         paused→running|cancelled ; awaiting_acceptance→succeeded|running|failed|cancelled. Terminal: succeeded, failed, cancelled.
succeeded precondition: acceptance receipt verdict pass AND openInvalidations(mission) == 0 (section 6).

TaskStatus = 'pending' | 'runnable' | 'leased' | 'running' | 'waiting' | 'succeeded' | 'invalidated' | 'repairing' | 'failed' | 'cancelled'
TaskRole   = 'planner' | 'investigator' | 'cache_specialist' | 'database_specialist' | 'routing_specialist' | 'verifier' | 'postcondition'
Capability = 'observe' | 'delegate' | 'propose_config_change' | 'propose_cache_flush' | 'publish_finding' | 'request_replan'
ROLE_CAPABILITIES (rev2 D5) = {
  planner: [], investigator: ['observe','delegate','publish_finding','request_replan'],
  cache_specialist: ['observe','delegate','publish_finding','propose_config_change','propose_cache_flush'],
  database_specialist: ['observe','delegate','publish_finding','propose_config_change'],
  routing_specialist: ['observe','delegate','publish_finding','propose_config_change'],
  verifier: ['observe','publish_finding'], postcondition: ['observe','publish_finding'],
}
// A task's capabilities ⊆ ROLE_CAPABILITIES[role] ∩ parent.capabilities. Specialists may delegate only role 'verifier'.

Task = {
  id: TaskId, missionId, parentId: TaskId | null, depth: number, ordinal: number,
  title: string (<= 160), question: string (<= 2000), role: TaskRole, capabilities: Capability[],
  status: TaskStatus, transitionVersion: number, generation: number,
  prerequisites: TaskId[],              // scheduling edges only
  fenceSeq: number, attemptCount: number, maxAttempts: number (default 3),
  budget: { maxIterations: number; maxTokens: number; maxChildren: number },
  outputId: TaskOutputId | null,
  createdByModelCallId: ModelCallId | null,   // provenance only; NOT an evidence edge (rev2 D1: the plan is a scheduling artifact)
  justification: string | null (<= 500),      // required for delegated tasks
  createdAt, finishedAt
}
Allowed: pending→runnable|cancelled ; runnable→leased|cancelled ; leased→running|runnable|cancelled ; running→waiting|succeeded|failed|invalidated|cancelled ;
         waiting→running|invalidated|failed|cancelled ; succeeded→invalidated ; invalidated→repairing|cancelled|failed ; repairing→runnable|cancelled.

AttemptStatus = 'running' | 'published' | 'failed' | 'aborted' | 'expired' | 'invalidated'
TaskAttempt = {
  id: AttemptId, taskId, missionId, n: number, kind: 'initial' | 'retry' | 'repair' | 'replan' | 'postcondition',
  status: AttemptStatus, generation: number, lease: Lease,
  readSetReceiptIds: ReceiptId[], modelCallIds: ModelCallId[],
  inheritedDependencyVector: DependencyVector,
  repairOf: { attemptId: AttemptId; invalidationEventId: InvalidationEventId } | null,
  abortReason: 'readset_invalidated' | 'mission_paused' | 'mission_cancelled' | 'lease_lost' | 'budget_exhausted' | 'provider_unreachable' | 'publication_rejected' | null,
  startedAt, finishedAt
}
Lease = { owner: string, fencingToken: number, expiresAt: string, renewedAt: string }

TaskOutput = { id: TaskOutputId, taskId, attemptId, kind: 'finding' | 'handoff' | 'plan' | 'verification',
               content: unknown (<= 32 KiB canonical), digest, dependencyVector: DependencyVector, usable: boolean, unusableReason: string | null, publishedAt }

EdgeKind = 'evidence' | 'inheritance' | 'scheduling'
DependencyEdge = { id, missionId, kind: EdgeKind,
  from: { kind: 'receipt' | 'model_call' | 'attempt' | 'task_output' | 'task' | 'action_intent'; id: string },
  to:   { kind: 'model_call' | 'attempt' | 'task_output' | 'task' | 'action_intent'; id: string }, createdAt }
```

Invariants: scheduling cycles rejected at plan validation and `delegate_task`; evidence/inheritance edges point older→newer. Caps checked in the enqueue transaction under `FOR UPDATE` on the mission row. `PlanSchema = { tasks: { title; question; role; capabilities; dependsOn: number[] /* ordinals */ }[] (2..6) }`.

---

## 5. ActionIntent, Authorization, ResultReceipt

```ts
ActionKind    = 'set_config' | 'flush_cache_namespace'
ActionStatus  = 'proposed' | 'admitted' | 'blocked' | 'committed' | 'dispatched' | 'verified' | 'failed' | 'outcome_unknown' | 'cancelled'
LIVE_STATUSES = ['proposed','admitted','committed','dispatched','outcome_unknown']   // (rev2 C5) scope of the unique idempotency index
BlockReason   = 'stale_version' | 'stale_pending_observation' | 'receipt_not_supported' | 'missing_required_source' | 'target_version_mismatch'
              | 'author_fence_invalid' | 'dispatch_fence_invalid' | 'idempotency_conflict' | 'capability_denied' | 'policy_version_mismatch'
              | 'payload_invalid' | 'expired' | 'evidence_too_old' | 'citation_out_of_scope' | 'mission_not_running' | 'generation_mismatch'   // (rev2 I2, I8)
FailureReason = 'postcondition_mismatch' | 'superseded_before_verification' | 'effect_not_applied' | 'dispatch_fence_invalid' | 'expired' | 'provider_error'   // (rev2 C7, C3)
PolicyVersion = 'policy-v1'

ActionIntent = {
  id: ActionId, missionId, taskId, attemptId, modelCallId: ModelCallId, toolCallId: string,   // (rev2 C10/C5) the emitting call
  authorFencingToken: number, generation: number,
  action: ActionKind, adapter: 'checkout_config' | 'redis_cache',
  payload: SetConfigPayload | FlushCachePayload, payloadHash: string,
  target: { resource: 'checkout'; sourceKey: SourceKey /* checkout.config/<key>; for flush: checkout.config/cache.namespace */; environment },
  actorCapability: Capability,
  dependencyVector: DependencyVector,     // server = emitting snapshot.dependencyVector ∪ cited (validated in scope), sorted
  requiredSources: SourceKey[],
  expectedTargetVersion: number,          // config_entries[target].version from the cited/observed member receipt (flush: cache.namespace version, rev2 C11)
  policyVersion: PolicyVersion,
  idempotencyKey: string,                 // (rev2 C5) sha256(missionId, taskId, attemptId, action, expectedTargetVersion, toolCallId)
  expiresAt: string,                      // proposedAt + 10 min
  rationale: string (<= 1000),
  status: ActionStatus, statusVersion: number, blockReason: BlockReason | null, blockDetail: string | null, failureReason: FailureReason | null,
  dispatch: { fence: number; owner: string; leaseExpiresAt: string } | null,   // present from admission on (rev2 C4)
  proposedAt, admittedAt, committedAt, dispatchedAt, verifiedAt, failedAt
}
SetConfigPayload  = { key: ConfigKey; value: string | number | boolean; expectedCurrentValueDigest: string }
FlushCachePayload = { namespace: string; reason: string }
ConfigKey = 'cache.namespace' | 'cache.schema_version' | 'db.pool_max' | 'db.statement_timeout_ms' | 'routing.inventory_source' | 'orders.write_enabled' | 'ui.banner_text'

AdapterPolicy (policy-v1) = {
  set_config:            { requiredSources: (p) => ['checkout.config/' + p.key, 'checkout.health'], maxAgeMs: { 'checkout.health': 120000 }, capability: 'propose_config_change', valueDomain: per ConfigKey },
  flush_cache_namespace: { requiredSources: () => ['checkout.config/cache.namespace', 'redis.stats'], maxAgeMs: { 'redis.stats': 120000 }, capability: 'propose_cache_flush', externalEffect: true },
}
// maxAgeMs is checked against lastConfirmedAt at admission AND at commit (freshness-at-admission; it is not a currency guarantee).

Authorization = {   // immutable; one per decision (admission, commit, re-admission); duplicate delivery writes none (rev2 C2)
  id, actionId, stage: 'admission' | 'commit' | 'dispatch', decidedAt, decision: 'admitted' | 'committed' | 'blocked' | 'dispatched',
  blockReason: BlockReason | null,
  checkedVector: { sourceKey; recordedRevision; liveRevision; receiptStatus: ReceiptStatus; lastConfirmedAt: string; freshnessOk: boolean }[],
  targetVersion: { expected: number; live: number }, authorFence: { token: number; valid: boolean }, dispatchFence: { token: number; valid: boolean } | null,
  policyVersion, idempotencyBinding: 'new' | 'same_payload' | 'conflict'
}

ResultReceipt = {
  id, actionId, idempotencyKey, payloadHash,
  outcome: 'committed' | 'dispatched' | 'verified' | 'failed' | 'outcome_unknown',
  controlPlane: { targetVersionBefore: number; targetVersionAfter: number | null; causedByActionId: ActionId; beforeDigest: string; afterDigest: string } | null,
  externalEffect: { attemptedAt; acknowledgedAt: string | null; scriptResult: 'applied' | 'already_applied' | 'fence_newer' | null; deletedCount: number | null; markerPresent: boolean | null; fenceBefore: number | null; fenceAfter: number | null } | null,   // (rev2 C3)
  postcondition: { kind: 'history' | 'observation'; receiptId: ReceiptId | null; configVersion: number | null } | null,   // (rev2 C7)
  recordedAt
}
```

Allowed: `proposed→admitted|blocked|cancelled|failed`; `admitted→committed|blocked|failed|cancelled`; `committed→dispatched|verified|outcome_unknown|failed`; `dispatched→verified|outcome_unknown|failed`; `outcome_unknown→verified|failed` (reconcile only). `blocked` is terminal for that intent; a fresh proposal from a new tool call gets a new key (blocked/failed/cancelled intents do not reserve keys: unique index `WHERE status IN LIVE_STATUSES`). Idempotency: same key + same `payloadHash` returns the stored decision/receipt; same key + different `payloadHash` (a replayed tool call id with a tampered payload) → `blocked(idempotency_conflict)`.

Citation scope (rev2 I8): each `supportingReceiptIds` entry must appear in the emitting model call's `snapshot.dependencyVector` or in the attempt's `readSetReceiptIds`/`inheritedDependencyVector`; otherwise `blocked(citation_out_of_scope)`. Receipt ids are citations checked against scope, never authority.

---

## 6. InvalidationEvent and RecoveryEvent

```ts
InvalidationEvent = {
  id: InvalidationEventId,            // sha256(sourceKey, oldReceiptId, newReceiptId | 'null', reason)
  missionIds: MissionId[],
  sourceKey: SourceKey, oldReceiptId: ReceiptId, newReceiptId: ReceiptId | null,
  reason: 'newer_observation' | 'conflicting_observation' | 'retraction' | 'expiry' | 'self_write_mismatch' | 'collection_changed' | 'publication_rejected' | 'closure_cap_exceeded',   // (rev2 C13, C14)
  selfWrite: 'none' | 'verified' | 'mismatch',
  graphVersion: number,
  affected: { modelCallIds; attemptIds; outputIds; actionIds; taskIds },     // global
  perMission: { missionId: MissionId; affected: InvalidationEvent['affected']; preserved: { taskIds: TaskId[] } }[],   // (rev2 I10) what each mission's stream receives
  closure: { depth: number; nodes: number; capped: boolean },
  resolvedAt: string | null,          // (rev2 D9) set by the coordinator when open == false
  createdAt
}
// open(e) := exists affected attempt not in {published, failed, aborted, expired, invalidated-with-successor-published} OR exists affected intent not in {blocked, failed, cancelled, verified}.

RecoveryEvent = {
  id, invalidationEventId, missionId,
  kind: 'repair_scheduled' | 'replan_scheduled' | 'postcondition_scheduled' | 'intent_blocked' | 'attempt_aborted' | 'branch_preserved' | 'repair_coalesced' | 'invalidation_resolved' | 'mission_paused_closure_cap',
  taskId: TaskId | null, attemptId: AttemptId | null, newAttemptId: AttemptId | null, actionId: ActionId | null,
  detail: string (<= 500), createdAt
}
```

---

## 7. Findings (model claims)

```ts
Finding = { id, missionId, taskId, attemptId, claim: string (<= 2000), supportingReceiptIds: ReceiptId[] /* same scope rule as section 5 */, confidence: 'low' | 'medium' | 'high',
            trust: 'model_claim', usable: boolean, dependencyVector: DependencyVector, createdAt }
```

A `Finding` is never converted into an `ObservationReceipt`. The UI renders findings in a separate column labelled "claim".

---

## 8. Mission events (durable SSE) with typed payloads (rev2 D4)

```ts
MissionEvent = { id: number /* coordinator.events.id; id order == commit order */, missionId, kind: EventKind, at: string, payload: EventPayload }

EventPayload (discriminated on kind) =
  | { kind: 'mission.created';       mission: Mission }
  | { kind: 'mission.status';        from: MissionStatus; to: MissionStatus; reason: string | null }
  | { kind: 'task.created';          task: Pick<Task,'id'|'parentId'|'depth'|'title'|'role'|'capabilities'|'prerequisites'|'justification'|'createdByModelCallId'> }
  | { kind: 'task.status';           taskId; from: TaskStatus; to: TaskStatus; reason: string | null }
  | { kind: 'attempt.started';       attemptId; taskId; n: number; attemptKind: TaskAttempt['kind']; repairOf: TaskAttempt['repairOf']; inheritedVectorSize: number }
  | { kind: 'attempt.finished';      attemptId; taskId; status: AttemptStatus; readSetReceiptIds: ReceiptId[]; modelCallCount: number }
  | { kind: 'attempt.aborted';       attemptId; taskId; abortReason: NonNullable<TaskAttempt['abortReason']> }
  | { kind: 'model_call.recorded';   modelCallId; attemptId; taskId; role: ModelRole; model: ModelCallRecord['model']; provider: ModelCallRecord['provider']; outcome: ModelCallRecord['outcome']; prefixDigest: string; contextDigest: string; usage: InferenceAttempt['usage']; attempts: number; dependencyVectorSize: number }
  | { kind: 'tool_call.recorded';    attemptId; toolCallId; name: string; durationMs: number; ok: boolean; receiptId: ReceiptId | null }
  | { kind: 'receipt.registered';    receiptId; sourceKey; sourceRevision: number; supersedes: ReceiptId | null; trust: TrustClass; selfWrite: ObservationReceipt['provenance']['selfWrite']; provenanceKind: ObservationReceipt['provenance']['kind']; contentDigest: string }
  | { kind: 'receipt.confirmed';     receiptId; sourceKey; confirmedAt: string }
  | { kind: 'receipt.transition';    receiptId; from: ReceiptStatus; to: ReceiptStatus; reason: TransitionReason }
  | { kind: 'finding.published';     findingId; taskId; attemptId; claim: string; confidence: Finding['confidence']; supportingReceiptIds: ReceiptId[] }
  | { kind: 'output.published';      outputId; taskId; attemptId; outputKind: TaskOutput['kind']; digest: string; dependencyVectorSize: number }
  | { kind: 'action.proposed';       actionId; taskId; attemptId; action: ActionKind; target: ActionIntent['target']; payloadHash: string; expectedTargetVersion: number; dependencyVector: DependencyVector; requiredSources: SourceKey[]; admissionNotBefore: string }
  | { kind: 'action.decided';        actionId; stage: Authorization['stage']; decision: Authorization['decision']; blockReason: BlockReason | null; blockDetail: string | null; checkedVector: Authorization['checkedVector']; targetVersion: Authorization['targetVersion']; dispatchFence: Authorization['dispatchFence'] }
  | { kind: 'action.committed';      actionId; targetVersionBefore: number; targetVersionAfter: number; causedByActionId: ActionId; afterDigest: string }
  | { kind: 'action.dispatched';     actionId; scriptResult: NonNullable<ResultReceipt['externalEffect']>['scriptResult']; deletedCount: number | null }
  | { kind: 'action.verified';       actionId; postcondition: NonNullable<ResultReceipt['postcondition']> }
  | { kind: 'action.failed';         actionId; failureReason: FailureReason; detail: string | null }
  | { kind: 'action.outcome_unknown'; actionId; detail: string }
  | { kind: 'invalidation.recorded'; invalidationEventId; sourceKey; oldReceiptId; newReceiptId: ReceiptId | null; reason: InvalidationEvent['reason']; selfWrite: InvalidationEvent['selfWrite']; affected: InvalidationEvent['affected'] /* this mission only */; preserved: { taskIds: TaskId[] }; closure: InvalidationEvent['closure'] }
  | { kind: 'invalidation.resolved'; invalidationEventId; resolvedAt: string }
  | { kind: 'recovery.recorded';     recovery: RecoveryEvent }
  | { kind: 'probe.recorded';        receiptId; verdict: 'pass' | 'fail'; invariants: { name: string; ok: boolean }[]; healthSamples: number; healthOk: number }
  | { kind: 'health.sampled';        checkout: { status: 'ok' | 'degraded' | 'down' }; provider: { reachable: boolean }; postgres: 'ok' | 'down'; redis: 'ok' | 'down' }
  | { kind: 'telemetry.updated';     summary: TelemetrySummary }
  | { kind: 'heartbeat' }
```

Never included: prompts, raw tool bodies, `control` data, env values, role URLs, the probe secret. Clients dedupe by id set; replay is `id > Last-Event-ID`. `contracts/events.ts` exports `EventPayloadSchema` (a `z.discriminatedUnion('kind', ...)`) that both the server (W4.2) and the client tests (W3.5) validate against.

---

## 9. Route DTOs (`/api/nemodots`)

| Route                                                           | Request                                                                                                               | Response                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                                                   |                                                                                                                       | `HealthStatus { mode: 'live' or 'fixture' or 'blocked', provider: { reachable, modelListed, model, host /* from OPENAI_BASE_URL */, checkedAt }, postgres: 'ok' or 'down', redis: 'ok' or 'down', checkout: { reachable, status }, intelligence: 'configured' or 'blocked', missingEnv: string[] /* names only; live needs OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL */, incidentDotIds: number /* count */ }` |
| `POST /missions`                                                | `{ goal, constraints?: string[], mode?: 'live' or 'fixture' /* must equal server mode */, admission?: { minAgeMs } }` | `Mission` (201); 503 `{ error, missingEnv }` when blocked; 400 when `mode` disagrees with the server                                                                                                                                                                                                                                                                                                               |
| `GET /missions`, `GET /missions/:id`                            |                                                                                                                       | `Mission[]`; `MissionSnapshot { mission, tasks, attempts, outputs, findings, receipts, confirmations, actions, authorizations, results, invalidations /* perMission subset */, recoveries, probe, telemetry, lastEventId }`                                                                                                                                                                                        |
| `POST /missions/:id/{start,pause,resume,cancel}`                | `{}`                                                                                                                  | `Mission`; 409 on illegal transition                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /missions/:id/events`                                      | header `Last-Event-ID`                                                                                                | `text/event-stream` of `MissionEvent`                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /missions/:id/{tasks,evidence,actions,recovery,telemetry}` |                                                                                                                       | typed arrays from the snapshot                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /sandbox/sources/:key`                                    | `{ value, expectedVersion }`                                                                                          | `{ key, version }` (owner manual edit; 409 on version mismatch)                                                                                                                                                                                                                                                                                                                                                    |
| `POST /sandbox/injector/run`                                    | `{ scenarioClass }`                                                                                                   | `{ runId }` only                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /sandbox/checkout/health`                                  |                                                                                                                       | proxied checkout `/health` plus `sampledAt`                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /telemetry/summary`                                        | `?missionId`                                                                                                          | `TelemetrySummary { calls, orphanedCalls, tokens: { prompt, completion, cached: { available: boolean, total: number or null } }, byModel[], byRole[], retries, errors, ttftMs: { p50, p95 } or null, prefixGroups: { prefixDigest, calls }[] }`                                                                                                                                                                    |
| `GET /evals/report`                                             |                                                                                                                       | latest checked-in summary or `{ status: 'NOT_RUN' }`                                                                                                                                                                                                                                                                                                                                                               |

Every mutation requires `Content-Type: application/json` (upstream middleware). Model-supplied ids never select authority: `missionId`/`taskId` come from the route and from server-side tool context.

---

## 10. Ports (`contracts/ports.ts`)

```ts
interface SupportValidator {
  // lockMode 'share' for G2 publications, 'update' for G1 commits; controlled rows are ALWAYS locked (rev2 C9)
  assertCurrent(
    client: PgClient,
    receiptIds: ReceiptId[],
    opts: {
      lockMode: 'share' | 'update';
      freshness?: { [sourceKey: string]: number /* maxAgeMs */ };
    },
  ): Promise<CheckedVector>;
}
interface SourceReaderPort {
  read(
    key: SourceKey,
    scope: Scope,
  ): Promise<{
    normalizedValue: unknown;
    raw: unknown;
    revisionHint: number | null;
  }>;
}
interface ActionAdmissionPort {
  propose(
    input: ProposeInput,
    ctx: AttemptContext & { modelCallId: ModelCallId; toolCallId: string },
  ): Promise<ActionIntent>;
  admit(actionId: ActionId, dispatcher: string): Promise<ActionIntent>; // proposed -> admitted | blocked (rev2 C4)
  commit(actionId: ActionId, dispatchFence: number): Promise<ActionIntent>; // admitted -> committed | blocked ; re-runs every predicate
  dispatch(actionId: ActionId, dispatchFence: number): Promise<ActionIntent>;
  reconcile(actionId: ActionId): Promise<ActionIntent>;
  cancelQueued(missionId: MissionId, generation: number): Promise<ActionId[]>;
}
interface MissionControlPort {
  create;
  start;
  pause;
  resume;
  cancel;
  snapshot(missionId);
}
interface EventSinkPort {
  append(
    client: PgClient,
    event: Omit<MissionEvent, 'id' | 'at'>,
  ): Promise<number>;
} // takes the events advisory xact lock
interface InferencePort {
  complete(
    req: ChatRequest,
    ctx: { signal; modelCallId; role },
  ): Promise<ChatResult>;
  listModels(): Promise<string[]>;
  host(): string;
}
interface ProbePort {
  run(missionId): Promise<ObservationReceipt>;
}
interface RecoveryPort {
  onInvalidation(event: InvalidationEvent): Promise<void>;
  onSelfWriteSettled(
    actionId: ActionId,
    outcome: 'verified' | 'failed',
  ): Promise<void>;
} // coordinator implements; watcher calls
```

`AttemptContext = { missionId, taskId, attemptId, fencingToken, generation, capabilities, role }` is created by the coordinator and passed to tools as `context.context`; nothing in it comes from the model.

---

## 11. Database naming (for reviewers)

Schemas: `ledger`, `coordinator`, `checkout`, `control`. Tables: `ledger.sources`, `ledger.source_revisions`, `ledger.observation_receipts`, `ledger.receipt_confirmations` (rev2), `ledger.receipt_transitions`, `ledger.model_call_records`, `ledger.context_snapshots`, `ledger.inference_attempts`, `ledger.dependency_edges`, `ledger.invalidation_events`, `ledger.tool_spans`, `ledger.mission_timing`, `coordinator.missions`, `coordinator.tasks`, `coordinator.task_attempts`, `coordinator.task_outputs`, `coordinator.findings`, `coordinator.action_intents`, `coordinator.authorizations`, `coordinator.result_receipts`, `coordinator.recovery_events`, `coordinator.outbox`, `coordinator.events`, `checkout.products`, `checkout.inventory`, `checkout.orders` (with `probe_run_id`), `checkout.order_items`, `checkout.config_entries`, `checkout.config_versions` (with `before_digest`, `after_digest`, `caused_by_action_id`, `caused_by_actor`), `checkout.config_collection`, `control.fault_schedules`, `control.scenario_runs`. Every status column has a `CHECK` equal to the enum; every transition is a CAS on `(id, status, status_version|transition_version)`. NOTIFY channels: `nemodots_outbox`, `nemodots_events`, `nemodots_source_changed`, `nemodots_action_proposed`.
