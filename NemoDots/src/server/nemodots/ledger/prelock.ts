// Lock order of the closure (review findings R3/R6, ARCHITECTURE.md 5.1/5.2).
//
// Publications (fence.ts) and commits lock COORDINATOR rows first (mission
// share, attempt, task, intent) and ask the LEDGER afterwards (config rows,
// registry rows, receipt rows). A closure used to do the opposite: it took the
// registry/config/receipt locks of the changed source and then wanted the
// coordinator rows it marks. Two transactions walking those orders towards each
// other deadlock; PostgreSQL resolves it after deadlock_timeout (1 s) by
// aborting one of them.
//
// The ledger now follows the coordinator's order. Before it takes ANY lock
// another transaction can wait on, a registration / retirement locks the
// coordinator rows it expects to mark, in the marker's own table order
// (attempts, tasks, outputs, intents; rows in id order):
//
//   1. preview  - read the closure of the current head without locks;
//   2. lock     - lock those coordinator rows FOR UPDATE (holding no ledger lock,
//                 so a publication or commit that holds one of them can finish
//                 its ledger calls and release);
//   3. ledger   - sources FOR UPDATE, config FOR SHARE, receipt rows; the
//                 closure is read again under these locks;
//   4. verify   - if the locked closure reaches coordinator rows that step 2
//                 did not lock (a publication committed new edges in between),
//                 nothing is written: ROLLBACK TO SAVEPOINT releases every lock
//                 of the round, the missing rows join the set, and the round
//                 repeats (bounded by MAX_ROUNDS, then ClosureUnstableError).
//
// The whole ledger lock order is therefore:
//   coordinator rows (attempts, tasks, outputs, intents)
//     -> controlled config rows (collection first, members by key)
//     -> ledger.sources
//     -> ledger.observation_receipts
//     -> edge advisory lock (per mission)
// and the order inside the ledger functions that run after a coordinator lock
// (assertCurrent, recordModelCall, recordReadSet) is the same suffix of it.
import type { Affected, PgClient } from '../contracts/index.js';
import { ClosureUnstableError } from './errors.js';
import { emptyAffected } from './closure.js';
import { coordinatorSchema, type LedgerOptions } from './options.js';

export const MAX_LOCK_ROUNDS = 6;
const SAVEPOINT = 'ledger_closure_round';

type AffectedKey = keyof Affected;

/** Union of affected sets, ids sorted and de-duplicated. */
export function unionAffected(sets: readonly Affected[]): Affected {
  const merged: Record<AffectedKey, string[]> = { ...emptyAffected() };
  for (const key of Object.keys(merged) as AffectedKey[]) {
    const ids = new Set<string>();
    for (const set of sets) for (const id of set[key]) ids.add(id);
    merged[key] = [...ids].sort();
  }
  return merged as unknown as Affected;
}

/** The coordinator tables a marker writes, in the order it (and the lock) takes them. */
const LOCKED_TABLES: { key: AffectedKey; table: string }[] = [
  { key: 'attemptIds', table: 'task_attempts' },
  { key: 'taskIds', table: 'tasks' },
  { key: 'outputIds', table: 'task_outputs' },
  { key: 'actionIds', table: 'action_intents' },
];

/**
 * Locks the coordinator rows named by `affected`. The MISSION rows they belong
 * to are share-locked FIRST: pause / cancel take the mission FOR UPDATE and
 * only then the attempt rows, and inserting a coordinator event takes a key
 * share on the mission, so a registration that locked attempt rows before the
 * mission could deadlock with a pause (adversarial finding C-02). Then one
 * statement per table, ids sorted, FOR UPDATE.
 */
export async function lockCoordinatorRows(
  client: PgClient,
  affected: Affected,
  options?: LedgerOptions,
): Promise<void> {
  const schema = coordinatorSchema(options);
  const missions = new Set<string>();
  for (const { key, table } of LOCKED_TABLES) {
    const ids = [...affected[key]];
    if (ids.length === 0 || table === 'task_outputs') continue;
    const { rows } = await client.query<{ mission_id: string }>(
      `SELECT DISTINCT mission_id FROM ${schema}.${table} WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    for (const row of rows) missions.add(row.mission_id);
  }
  if (missions.size > 0) {
    // ledger-only fixtures may not have a missions table
    const present = await client.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present',
      [`${schema}.missions`],
    );
    if (present.rows[0]?.present)
      await client.query(
        `SELECT id FROM ${schema}.missions WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
        [[...missions]],
      );
  }
  for (const { key, table } of LOCKED_TABLES) {
    const ids = [...affected[key]];
    if (ids.length === 0) continue;
    await client.query(
      `SELECT id FROM ${schema}.${table} WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
  }
}

/** Raised inside a round when the locked closure reaches rows the round did not lock. */
export class PrelockInsufficient extends Error {
  constructor(readonly missing: Affected) {
    super('the closure reaches coordinator rows that were not locked yet');
    this.name = 'PrelockInsufficient';
  }
}

/** Throws PrelockInsufficient unless every marked kind of `closure` is inside `locked`. */
export function assertLocked(locked: Affected, closure: Affected): void {
  const missing = emptyAffected() as unknown as Record<AffectedKey, string[]>;
  let any = false;
  for (const { key } of LOCKED_TABLES) {
    const have = new Set<string>(locked[key]);
    const lacking = closure[key].filter((id) => !have.has(id));
    if (lacking.length > 0) {
      missing[key] = lacking;
      any = true;
    }
  }
  if (any) throw new PrelockInsufficient(missing as unknown as Affected);
}

export interface ClosureLockPlan {
  /** false skips coordinator locking (no marks are written): the body runs once, unwrapped. */
  enabled: boolean;
  ledger?: LedgerOptions;
  /**
   * Unlocked view of what the step will mark (null: nothing to pre-lock).
   * May throw ClosureCapExceeded, which ends the step without writes.
   */
  preview: () => Promise<Affected | null>;
  maxRounds?: number;
}

/**
 * Runs `body` with the coordinator rows of its closure already locked (see the
 * module header). `body(locked)` must call assertLocked(locked, closure) as soon
 * as it knows the closure and before it writes anything.
 *
 * Every round runs in a savepoint: a failure (including PrelockInsufficient)
 * rolls the round back, releasing all of its locks, and rethrows unless it is
 * the retryable PrelockInsufficient.
 */
export async function runWithClosureLocks<T>(
  client: PgClient,
  plan: ClosureLockPlan,
  body: (locked: Affected) => Promise<T>,
): Promise<T> {
  if (!plan.enabled) return body(emptyAffected());
  const maxRounds = plan.maxRounds ?? MAX_LOCK_ROUNDS;
  let locked = emptyAffected();
  for (let round = 1; ; round += 1) {
    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const candidate = await plan.preview();
      if (candidate) locked = unionAffected([locked, candidate]);
      await lockCoordinatorRows(client, locked, plan.ledger);
      const result = await body(locked);
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return result;
    } catch (error) {
      // Restore a usable transaction and drop the round's locks, whatever failed.
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      } catch {
        // The connection is gone; the original error is the useful one.
      }
      if (error instanceof PrelockInsufficient) {
        locked = unionAffected([locked, error.missing]);
        if (round >= maxRounds) throw new ClosureUnstableError(round);
        continue;
      }
      throw error;
    }
  }
}
