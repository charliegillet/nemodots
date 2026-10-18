// Owner edit: advanceConfig(actor:'owner') through the version authority, then
// an immediate observation so the receipt and its invalidation do not wait for
// the next poll. The owner's identity never reaches the ledger (redaction).
import type pg from 'pg';
import {
  advanceConfigTx,
  type AdvanceConfigInput,
  type AdvanceConfigResult,
} from '../sandbox/version-authority.js';
import type { PassStats } from './types.js';
import type { Watcher } from './watcher.js';

export interface OwnerEdit {
  key: string;
  value?: AdvanceConfigInput['value'];
  expectedVersion: number;
  insertIfMissing?: boolean;
  deleteKey?: boolean;
}

export async function ownerEdit(
  deps: { pool: pg.Pool; watcher: Pick<Watcher, 'observe'> },
  edit: OwnerEdit,
): Promise<{ change: AdvanceConfigResult; observed: PassStats }> {
  const change = await advanceConfigTx(deps.pool, {
    ...edit,
    causedBy: { actor: 'owner' },
  });
  const keys = [`checkout.config/${edit.key}`];
  if (change.membershipChanged) keys.push('checkout.config');
  const observed = await deps.watcher.observe(keys);
  return { change, observed };
}
