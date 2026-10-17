// Independent derivations over a mission snapshot and its event stream. They
// use only recorded data (readsets, inherited vectors, output vectors, event
// order) and a traversal written here, never production graph code.
import type { MissionEvent } from '../../../../src/server/nemodots/contracts/index.js';

export interface AttemptLike {
  id: string;
  taskId: string;
  n: number;
  kind: string;
  status: string;
  readSetReceiptIds: readonly string[];
  inheritedDependencyVector: readonly { receiptId: string }[];
  repairOf: { attemptId: string; invalidationEventId: string } | null;
  abortReason: string | null;
  lease: { fencingToken: number };
}
export interface OutputLike {
  taskId: string;
  attemptId: string;
  usable: boolean;
  dependencyVector: readonly { receiptId: string }[];
}
export interface TaskLike {
  id: string;
  parentId: string | null;
  depth: number;
  role: string;
  title: string;
  capabilities: readonly string[];
  prerequisites: readonly string[];
  justification: string | null;
  createdByModelCallId: string | null;
  attemptCount: number;
  status: string;
}
export interface ReceiptLike {
  id: string;
  supersedes: string | null;
  supersededBy: string | null;
  sourceRevision: number;
  source: { key: string };
}
export interface SnapshotLike {
  tasks: readonly TaskLike[];
  attempts: readonly AttemptLike[];
  outputs: readonly OutputLike[];
  receipts: readonly ReceiptLike[];
}

/** Tasks whose recorded evidence depends on `oldReceiptId` (conservative, vector based). */
export function affectedTaskIds(snapshot: SnapshotLike, oldReceiptId: string) {
  const affected = new Set<string>();
  for (const attempt of snapshot.attempts) {
    if (
      attempt.readSetReceiptIds.includes(oldReceiptId) ||
      attempt.inheritedDependencyVector.some((e) => e.receiptId === oldReceiptId)
    )
      affected.add(attempt.taskId);
  }
  for (const output of snapshot.outputs)
    if (output.dependencyVector.some((e) => e.receiptId === oldReceiptId))
      affected.add(output.taskId);
  return affected;
}

export function preservedTaskIds(snapshot: SnapshotLike, oldReceiptId: string) {
  const affected = affectedTaskIds(snapshot, oldReceiptId);
  return new Set(snapshot.tasks.filter((t) => !affected.has(t.id)).map((t) => t.id));
}

/** Receipts that were superseded, with the receipt that replaced them. */
export function supersessions(snapshot: SnapshotLike) {
  return snapshot.receipts
    .filter((r) => r.supersededBy)
    .map((r) => ({ old: r, next: snapshot.receipts.find((n) => n.id === r.supersededBy) ?? null }));
}

export function childrenOf(snapshot: SnapshotLike, taskId: string) {
  return snapshot.tasks.filter((t) => t.parentId === taskId);
}

/** Maximum depth and breadth recorded in the task tree. */
export function treeShape(snapshot: SnapshotLike) {
  const maxDepth = Math.max(0, ...snapshot.tasks.map((t) => t.depth));
  const maxBreadth = Math.max(0, ...snapshot.tasks.map((t) => childrenOf(snapshot, t.id).length));
  return { total: snapshot.tasks.length, maxDepth, maxBreadth };
}

export function hasCycle(snapshot: SnapshotLike) {
  const color = new Map<string, number>();
  const byId = new Map(snapshot.tasks.map((t) => [t.id, t] as const));
  const visit = (id: string): boolean => {
    const state = color.get(id) ?? 0;
    if (state === 1) return true;
    if (state === 2) return false;
    color.set(id, 1);
    for (const p of byId.get(id)?.prerequisites ?? []) if (byId.has(p) && visit(p)) return true;
    color.set(id, 2);
    return false;
  };
  return snapshot.tasks.some((t) => visit(t.id));
}

type Payload = MissionEvent['payload'];
export function ofKind<K extends Payload['kind']>(events: readonly MissionEvent[], kind: K) {
  return events.filter((e) => e.payload.kind === kind) as (MissionEvent & {
    payload: Extract<Payload, { kind: K }>;
  })[];
}

/** attemptId -> taskId from attempt.started events. */
export function attemptTaskMap(events: readonly MissionEvent[]) {
  const map = new Map<string, string>();
  for (const e of ofKind(events, 'attempt.started')) map.set(e.payload.attemptId, e.payload.taskId);
  return map;
}

/** Model calls recorded after `afterEventId` for any of `taskIds`. */
export function modelCallsFor(events: readonly MissionEvent[], taskIds: ReadonlySet<string>, afterEventId = 0) {
  return ofKind(events, 'model_call.recorded').filter(
    (e) => e.id > afterEventId && taskIds.has(e.payload.taskId),
  );
}

/** Mutating attempts per (task) after an event id: used for repair-storm bounds. */
export function attemptsPerTask(snapshot: SnapshotLike) {
  const count = new Map<string, number>();
  for (const a of snapshot.attempts) count.set(a.taskId, (count.get(a.taskId) ?? 0) + 1);
  return count;
}

/** Repair attempts grouped by invalidation event and task. */
export function repairsByInvalidation(snapshot: SnapshotLike) {
  const groups = new Map<string, number>();
  for (const a of snapshot.attempts)
    if (a.repairOf) {
      const key = `${a.repairOf.invalidationEventId}|${a.taskId}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
  return groups;
}

/** Fencing tokens must strictly increase per task across attempts (no reuse). */
export function fencingMonotonic(snapshot: SnapshotLike) {
  const byTask = new Map<string, AttemptLike[]>();
  for (const a of snapshot.attempts) byTask.set(a.taskId, [...(byTask.get(a.taskId) ?? []), a]);
  for (const list of byTask.values()) {
    const sorted = [...list].sort((a, b) => a.n - b.n);
    for (let i = 1; i < sorted.length; i += 1)
      if (sorted[i].lease.fencingToken <= sorted[i - 1].lease.fencingToken) return false;
  }
  return true;
}

/** Words that would reveal the injected diagnosis or verifier machinery to the team. */
export const LEAK_PATTERNS: readonly RegExp[] = [
  /\binjector\b/i,
  /\binjected (fault|change|value|step)/i,
  /\bfault[_ -]?schedule/i,
  /\bscenario[_ -]?(class|run|id)/i,
  /\bmanifest\b/i,
  /\bcontrol\./i,
  /nemodots_verifier/i,
  /nemodots_injector/i,
  /\bheld[- ]?out\b/i,
  /acceptance[- ]contract/i,
];

export function findLeaks(texts: readonly string[], extra: readonly string[] = []) {
  const hits = new Set<string>();
  for (const text of texts) {
    for (const pattern of LEAK_PATTERNS) if (pattern.test(text)) hits.add(pattern.source);
    for (const word of extra) if (text.includes(word)) hits.add(`literal:${word}`);
  }
  return [...hits];
}

/** Texts of non-system messages in recorded provider requests (tool results, user turns). */
export function nonSystemTexts(body: Record<string, any>): string[] {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .filter((m) => m?.role !== 'system' && m?.role !== 'developer')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p: any) => p?.text ?? '').join('\n')
          : '',
    );
}
