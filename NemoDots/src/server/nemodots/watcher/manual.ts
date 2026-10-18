import type pg from 'pg';
import {
  advanceConfigTx,
  type AdvanceConfigResult,
  type ConfigScalar,
} from '../sandbox/version-authority.js';
import { COLLECTION_KEY, memberSourceKey } from './sources.js';
import type { ObserveOutcome } from './types.js';
import type { Watcher } from './watcher.js';

// Owner manual edit (ARCHITECTURE 5.1: the owner is the third writer of the
// controlled sources). The edit goes through the same version authority as the
// injector and the actions (`advanceConfig`, actor 'owner', compare-and-set on
// the version the owner saw), and the new revision is observed IMMEDIATELY
// instead of waiting for the next poll or notification. The edit and the
// observation run under the watcher's mutex, so the receipt carries the
// `owner_edit` provenance and a concurrent poll cannot register it first as an
// ordinary watcher observation.
//
// The owner is a legitimate actor: the edit invalidates dependents like any
// other change (selfWrite 'none': it is not a self-write of the agent team).
// The actor name is stored only in checkout.config_versions; receipts record
// the provenance kind and nothing that identifies the actor further.

export interface OwnerEditInput {
  /** Config member key (for example `ui.banner_text`), not the source key. */
  key: string;
  value: ConfigScalar;
  /** The version the owner saw; a different current version fails with stale_version. */
  expectedVersion: number;
}

export interface OwnerEditResult {
  change: AdvanceConfigResult;
  observations: ObserveOutcome[];
}

export interface OwnerEdit {
  (input: OwnerEditInput): Promise<OwnerEditResult>;
}

export function createOwnerEdit(deps: {
  /** nemodots_app pool. */
  pool: pg.Pool;
  watcher: Watcher;
}): OwnerEdit {
  return (input) =>
    deps.watcher.withExclusive(async (ops) => {
      const change = await advanceConfigTx(deps.pool, {
        key: input.key,
        value: input.value,
        expectedVersion: input.expectedVersion,
        causedBy: { actor: 'owner' },
      });
      const keys = [memberSourceKey(input.key) as string];
      if (change.membershipChanged) keys.push(COLLECTION_KEY);
      const observations = await ops.observe(keys, { kind: 'owner_edit' });
      return { change, observations };
    });
}
