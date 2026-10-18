// Scope isolation (CONTRACTS.md section 1, verifier finding F4): a receipt can
// support work in mission M only if its source's owner, environment, Space and
// resource all equal M's scope. Enforced here, once, for every ledger entry
// point that takes a mission (assertCurrent, recordReadSet, recordModelCall).
//
// The mission's scope comes from coordinator.missions (the server's own row,
// read inside the caller's transaction) and from nothing else: a mission with
// no row is unknown and is always refused. A scope the caller also passes is
// only an extra consistency check and must equal the stored one; it is never
// trusted in place of the row.
import type { Environment, PgClient } from '../contracts/index.js';
import { SupportError } from './errors.js';
import { coordinatorSchema, type LedgerOptions } from './options.js';
import type { ReceiptRow } from './receipt-store.js';

export interface MissionScope {
  ownerId: string;
  environment: Environment;
  spaceId: string | null;
  resource: string;
}

const norm = (scope: MissionScope): MissionScope => ({
  ownerId: scope.ownerId,
  environment: scope.environment,
  spaceId: scope.spaceId ?? null,
  resource: scope.resource,
});

export async function resolveMissionScope(
  client: PgClient,
  missionId: string,
  options?: LedgerOptions,
  claimed?: MissionScope,
): Promise<MissionScope> {
  const schema = coordinatorSchema(options);
  const unknown = () =>
    new SupportError(
      'citation_out_of_scope',
      `mission ${missionId} is unknown, so its scope cannot be established`,
    );
  const present = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`${schema}.missions`],
  );
  if (!present.rows[0]?.present) throw unknown();
  const { rows } = await client.query<{
    owner_id: string;
    environment: Environment;
    space_id: string | null;
    resource: string;
  }>(
    `SELECT owner_id, environment, space_id, resource
       FROM ${schema}.missions WHERE id = $1`,
    [missionId],
  );
  if (!rows[0]) throw unknown();
  const stored = norm({
    ownerId: rows[0].owner_id,
    environment: rows[0].environment,
    spaceId: rows[0].space_id,
    resource: rows[0].resource,
  });
  if (claimed) {
    const given = norm(claimed);
    if (
      given.ownerId !== stored.ownerId ||
      given.environment !== stored.environment ||
      given.spaceId !== stored.spaceId ||
      given.resource !== stored.resource
    )
      throw new SupportError(
        'citation_out_of_scope',
        `the scope claimed for mission ${missionId} differs from the mission`,
      );
  }
  return stored;
}

/** Dimensions in which the receipt's source differs from the mission scope. */
export function scopeMismatches(
  row: Pick<ReceiptRow, 'ownerId' | 'environment' | 'spaceId' | 'resource'>,
  scope: MissionScope,
): string[] {
  const out: string[] = [];
  if (row.ownerId !== scope.ownerId) out.push('owner');
  if (row.environment !== scope.environment) out.push('environment');
  if ((row.spaceId ?? null) !== (scope.spaceId ?? null)) out.push('space');
  if (row.resource !== scope.resource) out.push('resource');
  return out;
}

/** Throws SupportError('citation_out_of_scope') for the first receipt outside `scope`. */
export function assertInScope(
  rows: Iterable<ReceiptRow>,
  scope: MissionScope,
): void {
  for (const row of rows) {
    const bad = scopeMismatches(row, scope);
    if (bad.length > 0)
      throw new SupportError(
        'citation_out_of_scope',
        `receipt ${row.id} (${row.sourceKey}) belongs to another ${bad.join(' and ')} than the mission`,
        [],
        row.id,
        row.sourceKey,
      );
  }
}
