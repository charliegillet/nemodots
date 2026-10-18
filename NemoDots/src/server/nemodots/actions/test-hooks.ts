// Barriers for the race tests and the W5 adversary. A hook is a named
// suspension point inside the admission / commit / dispatch code paths. They
// are active ONLY when NEMODOTS_TEST_HOOKS=1 and a handler was registered;
// otherwise `hook()` is a no-op that costs one property read.
//
//   after_preliminary_read       admit/commit: intent read, nothing locked yet
//   before_lock                  commit: before the intent row is locked
//   after_lock_before_commit     commit: every predicate passed and the
//                                mutation is written, before COMMIT
//   after_commit_before_dispatch committed in PostgreSQL, effect not started
//   after_claim_before_effect    dispatch claimed, Redis not touched yet
//   after_effect_before_record   Redis effect done, outcome not yet recorded
//
// A hook never runs inside a context that holds a transaction open across a
// network call by design: the commit hooks deliberately park INSIDE the
// transaction (that is the point of `after_lock_before_commit`), and only in
// tests.
import type { ActionId } from '../contracts/index.js';

export const HOOK_NAMES = Object.freeze([
  'after_preliminary_read',
  'before_lock',
  'after_lock_before_commit',
  'after_commit_before_dispatch',
  'after_claim_before_effect',
  'after_effect_before_record',
] as const);
export type HookName = (typeof HOOK_NAMES)[number];

export interface HookContext {
  actionId: ActionId | string;
  /** Present for hooks that run inside a transaction. */
  attempt?: number;
}
export type HookHandler = (context: HookContext) => Promise<void> | void;

const handlers = new Map<HookName, HookHandler>();

export const hooksEnabled = () => process.env.NEMODOTS_TEST_HOOKS === '1';

/** Registers a handler; returns the function that removes it. Throws unless hooks are enabled. */
export function setHook(name: HookName, handler: HookHandler): () => void {
  if (!hooksEnabled()) throw new Error('test hooks need NEMODOTS_TEST_HOOKS=1');
  if (!HOOK_NAMES.includes(name)) throw new Error(`unknown hook ${name}`);
  handlers.set(name, handler);
  return () => {
    if (handlers.get(name) === handler) handlers.delete(name);
  };
}

export function clearHooks() {
  handlers.clear();
}

export async function hook(name: HookName, context: HookContext) {
  if (handlers.size === 0 || !hooksEnabled()) return;
  await handlers.get(name)?.(context);
}
