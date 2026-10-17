import type { ActionStatus } from './action.js';
import type { ReceiptStatus } from './observation.js';
import type { AttemptStatus, MissionStatus, TaskStatus } from './task.js';

// Allowed-transition tables (ARCHITECTURE.md section 7, CONTRACTS.md sections
// 2, 4, 5). Every status change is a CAS that must be listed here; anything
// absent is forbidden. Terminal states map to [].

type Table<S extends string> = Readonly<Record<S, readonly S[]>>;

function freezeTable<S extends string>(
  table: Record<S, readonly S[]>,
): Table<S> {
  for (const targets of Object.values(table)) Object.freeze(targets);
  return Object.freeze(table);
}

export const MISSION_TRANSITIONS: Table<MissionStatus> =
  freezeTable<MissionStatus>({
    created: ['running', 'blocked_provider', 'cancelled'],
    // Verbatim CONTRACTS section 4. running->blocked_provider (ARCHITECTURE 10
    // prose) is NOT in the spec lists and is pending a lead ruling.
    running: ['paused', 'awaiting_acceptance', 'failed', 'cancelled'],
    blocked_provider: ['created', 'cancelled'],
    paused: ['running', 'cancelled'],
    awaiting_acceptance: ['succeeded', 'running', 'failed', 'cancelled'],
    succeeded: [],
    failed: [],
    cancelled: [],
  });

export const TASK_TRANSITIONS: Table<TaskStatus> = freezeTable<TaskStatus>({
  pending: ['runnable', 'cancelled'],
  runnable: ['leased', 'cancelled'],
  leased: ['running', 'runnable', 'cancelled'],
  // Verbatim CONTRACTS section 4. running->runnable (ARCHITECTURE 7.2 diagram,
  // reaper prose) is NOT in the spec lists and is pending a lead ruling.
  running: ['waiting', 'succeeded', 'failed', 'invalidated', 'cancelled'],
  waiting: ['running', 'invalidated', 'failed', 'cancelled'],
  succeeded: ['invalidated'],
  invalidated: ['repairing', 'cancelled', 'failed'],
  repairing: ['runnable', 'cancelled'],
  failed: [],
  cancelled: [],
});

export const ATTEMPT_TRANSITIONS: Table<AttemptStatus> =
  freezeTable<AttemptStatus>({
    running: ['published', 'failed', 'aborted', 'expired', 'invalidated'],
    published: [],
    failed: [],
    aborted: [],
    expired: [],
    invalidated: [],
  });

export const ACTION_TRANSITIONS: Table<ActionStatus> =
  freezeTable<ActionStatus>({
    proposed: ['admitted', 'blocked', 'cancelled', 'failed'],
    admitted: ['committed', 'blocked', 'failed', 'cancelled'],
    committed: ['dispatched', 'verified', 'outcome_unknown', 'failed'],
    dispatched: ['verified', 'outcome_unknown', 'failed'],
    /** reconcile only */
    outcome_unknown: ['verified', 'failed'],
    blocked: [],
    verified: [],
    failed: [],
    cancelled: [],
  });

export const RECEIPT_TRANSITIONS: Table<ReceiptStatus> =
  freezeTable<ReceiptStatus>({
    supported: ['superseded', 'contested', 'retracted', 'expired'],
    contested: ['supported', 'retracted'],
    superseded: [],
    retracted: [],
    expired: [],
  });

export const TRANSITION_TABLES = Object.freeze({
  mission: MISSION_TRANSITIONS,
  task: TASK_TRANSITIONS,
  attempt: ATTEMPT_TRANSITIONS,
  action: ACTION_TRANSITIONS,
  receipt: RECEIPT_TRANSITIONS,
});

export type TransitionKind = keyof typeof TRANSITION_TABLES;
type StatusOf = {
  mission: MissionStatus;
  task: TaskStatus;
  attempt: AttemptStatus;
  action: ActionStatus;
  receipt: ReceiptStatus;
};

export function canTransition<K extends TransitionKind>(
  kind: K,
  from: StatusOf[K],
  to: StatusOf[K],
): boolean {
  const table = TRANSITION_TABLES[kind] as Table<string>;
  return Object.hasOwn(table, from) && table[from].includes(to);
}

/**
 * Terminal statuses as documented (ARCHITECTURE 7 / CONTRACTS 4). A succeeded
 * task is terminal for scheduling even though invalidation may reopen it.
 */
export const TERMINAL_STATUSES = Object.freeze({
  mission: Object.freeze(['succeeded', 'failed', 'cancelled']),
  task: Object.freeze(['succeeded', 'failed', 'cancelled']),
  attempt: Object.freeze([
    'published',
    'failed',
    'aborted',
    'expired',
    'invalidated',
  ]),
  action: Object.freeze(['blocked', 'verified', 'failed', 'cancelled']),
  receipt: Object.freeze(['superseded', 'retracted', 'expired']),
} as const satisfies { [K in TransitionKind]: readonly StatusOf[K][] });

export function isTerminal<K extends TransitionKind>(
  kind: K,
  status: StatusOf[K],
): boolean {
  return (TERMINAL_STATUSES[kind] as readonly string[]).includes(status);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly kind: TransitionKind,
    readonly from: string,
    readonly to: string,
  ) {
    super(`illegal ${kind} transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition<K extends TransitionKind>(
  kind: K,
  from: StatusOf[K],
  to: StatusOf[K],
): void {
  if (!canTransition(kind, from, to))
    throw new IllegalTransitionError(kind, from, to);
}
