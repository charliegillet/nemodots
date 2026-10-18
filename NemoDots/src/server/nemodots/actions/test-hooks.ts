// Named race barriers at the real boundaries of the action transactions
// (TEST_PROMPT gate 2). They exist so the concurrency adversary can park one
// caller at a boundary while another runs, without editing production code.
//
//   after_preliminary_read       after the non-locking read, before BEGIN
//   before_lock                  inside the transaction, before the intent row lock
//   after_lock_before_commit     all locks held and all rows written, before COMMIT
//   after_commit_before_dispatch after the commit transaction returned
//   after_effect_before_record   after the Redis script ran, before the outcome is recorded
//
// Barriers are inert unless NEMODOTS_TEST_HOOKS=1; registering a handler
// without it throws, so a handler can never be left behind in a live process.
// A handler may await a latch (park), or throw SimulatedCrash to model process
// death: SimulatedCrash is rethrown untouched by every catch block in this
// package, so a crash never looks like a graceful outcome_unknown.
export const BARRIER_NAMES = Object.freeze([
  'after_preliminary_read',
  'before_lock',
  'after_lock_before_commit',
  'after_commit_before_dispatch',
  'after_effect_before_record',
] as const);
export type BarrierName = (typeof BARRIER_NAMES)[number];

export interface BarrierContext {
  actionId: string;
  /** Which operation reached the barrier. */
  stage: 'propose' | 'admit' | 'commit' | 'dispatch' | 'reconcile';
}

export type BarrierHandler = (context: BarrierContext) => void | Promise<void>;

export class TestHooksDisabledError extends Error {
  constructor() {
    super('test hooks are disabled: set NEMODOTS_TEST_HOOKS=1 to register one');
    this.name = 'TestHooksDisabledError';
  }
}

/** Throw this from a barrier handler to model the process dying at that point. */
export class SimulatedCrash extends Error {
  constructor(readonly barrier: BarrierName) {
    super(`simulated crash at ${barrier}`);
    this.name = 'SimulatedCrash';
  }
}

export function testHooksEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NEMODOTS_TEST_HOOKS === '1';
}

const handlers = new Map<BarrierName, BarrierHandler>();

/** Registers (or with null, removes) the handler of one barrier. Returns a remover. */
export function setBarrier(
  name: BarrierName,
  handler: BarrierHandler | null,
): () => void {
  if (!(BARRIER_NAMES as readonly string[]).includes(name))
    throw new RangeError(`unknown barrier ${String(name)}`);
  if (!testHooksEnabled()) throw new TestHooksDisabledError();
  if (handler) handlers.set(name, handler);
  else handlers.delete(name);
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

export function clearBarriers() {
  handlers.clear();
}

/** Reached by production code; a no-op unless hooks are enabled and a handler is set. */
export async function barrier(
  name: BarrierName,
  context: BarrierContext,
): Promise<void> {
  if (!testHooksEnabled()) return;
  const handler = handlers.get(name);
  if (handler) await handler(context);
}

export const isSimulatedCrash = (error: unknown): error is SimulatedCrash =>
  error instanceof SimulatedCrash;
