// Observed sources are read first and registered later. The ledger orders
// observed revisions by arrival, so an older sample that arrives after a tool or
// probe registered (or confirmed) a LATER reading would supersede the newer
// truth. The watcher rolls such a registration back and reads again; a stale
// sample never becomes the current receipt.
import { describe, expect, it } from 'vitest';
import type { SourceReaderPort } from '../../../../src/server/nemodots/contracts/index.js';
import { registerObservation } from '../../../../src/server/nemodots/ledger/index.js';
import {
  confirmationCount,
  headOf,
  receiptsOf,
  sleep,
  withWatcherEnv,
  type WatcherEnv,
} from './harness.js';

const HEALTH = 'checkout.health';

async function toolRegisters(
  env: WatcherEnv,
  value: unknown,
  missionId: string,
  key = HEALTH,
) {
  const client = await env.app.connect();
  try {
    await client.query('BEGIN');
    await registerObservation(client, {
      source: {
        key: key as never,
        sourceType: 'observed_endpoint',
        authority: 'observed',
        scope: {
          ownerId: 'owner',
          missionId: missionId as never,
          spaceId: null,
          environment: 'test',
          resource: 'checkout',
        },
      },
      normalizedValue: value,
      provenance: { kind: 'tool_call', toolCallId: 'tool-stale-sample' },
      observedAt: new Date(),
    });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function observedAts(env: WatcherEnv, key: string) {
  const { rows } = await env.admin.query<{
    source_revision: string;
    observed_at: Date;
    normalized_value: { status?: string };
  }>(
    `SELECT r.source_revision, r.observed_at, r.normalized_value
       FROM ledger.observation_receipts r JOIN ledger.sources s ON s.id = r.source_id
      WHERE s.key = $1 AND s.owner_id = 'owner' ORDER BY r.source_revision`,
    [key],
  );
  return rows.map((row) => ({
    revision: Number(row.source_revision),
    at: row.observed_at.getTime(),
    status: row.normalized_value.status,
  }));
}

describe('an observed sample that is older than the ledger head', () => {
  it('is not registered when a tool registered a later reading while the watcher was reading', async () => {
    await withWatcherEnv(async (env) => {
      const base = env.watcher();
      await base.runCycle();
      await base.runCycle();
      const first = await headOf(env, HEALTH);

      let calls = 0;
      const readers: SourceReaderPort = {
        async read(key, scope) {
          const read = await env.readers.read(key, scope);
          if (key !== HEALTH) return read;
          calls += 1;
          const value = read.normalizedValue as Record<string, unknown>;
          if (calls === 1) {
            // the watcher holds this (soon stale) sample; a tool reads LATER
            await sleep(20);
            await toolRegisters(
              env,
              { ...value, status: 'degraded-newer' },
              first.missionId,
            );
            return read;
          }
          // the second read of the watcher sees the truth after the tool's
          return { ...read, normalizedValue: { ...value, status: 'recovered' } };
        },
      };
      const watcher = env.watcher({ readers });
      const [outcome] = await watcher.observe([HEALTH]);

      const rows = await observedAts(env, HEALTH);
      // revision 2 is the tool's reading; revision 3 is the watcher's SECOND
      // read. The stale first sample ('ok') is never a revision.
      expect(rows.map((r) => [r.revision, r.status])).toEqual([
        [1, first.normalizedValue && (first.normalizedValue as { status: string }).status],
        [2, 'degraded-newer'],
        [3, 'recovered'],
      ]);
      // observed_at never goes backwards along the revisions
      expect(rows[1].at).toBeGreaterThanOrEqual(rows[0].at);
      expect(rows[2].at).toBeGreaterThanOrEqual(rows[1].at);
      expect(outcome).toMatchObject({ outcome: 'registered', revision: 3 });
      expect(
        env.events.filter((e) => e.type === 'stale_sample_discarded'),
      ).toEqual([{ type: 'stale_sample_discarded', sourceKey: HEALTH, attempt: 1 }]);
      expect((await receiptsOf(env, HEALTH)).map((r) => r.status)).toEqual([
        'superseded',
        'superseded',
        'supported',
      ]);
    });
  });

  it('is not registered when a tool confirmed the head at a later time (different, older value)', async () => {
    await withWatcherEnv(async (env) => {
      const base = env.watcher();
      await base.runCycle();
      await base.runCycle();
      const first = await headOf(env, HEALTH);
      const confirmationsBefore = await confirmationCount(env, HEALTH);

      let calls = 0;
      const readers: SourceReaderPort = {
        async read(key, scope) {
          const read = await env.readers.read(key, scope);
          if (key !== HEALTH) return read;
          calls += 1;
          const value = read.normalizedValue as Record<string, unknown>;
          if (calls === 1) {
            // the watcher's sample is an older, different reading ...
            const stale = { ...read, normalizedValue: { ...value, status: 'stale-blip' } };
            // ... and a tool re-reads the head value LATER (a confirmation)
            await sleep(20);
            await toolRegisters(env, value, first.missionId);
            return stale;
          }
          return read;
        },
      };
      const watcher = env.watcher({ readers });
      const [outcome] = await watcher.observe([HEALTH]);

      // no revision for the stale blip; the second read equals the head: confirmation
      expect((await receiptsOf(env, HEALTH)).map((r) => r.revision)).toEqual([1]);
      expect(outcome).toMatchObject({ outcome: 'confirmed', revision: 1 });
      expect(await confirmationCount(env, HEALTH)).toBe(confirmationsBefore + 2);
      expect(
        env.events.filter((e) => e.type === 'stale_sample_discarded'),
      ).toHaveLength(1);
    });
  });

  it('gives up after a bounded number of re-reads and reports rejected, not a silent success', async () => {
    await withWatcherEnv(async (env) => {
      const base = env.watcher();
      await base.runCycle();
      await base.runCycle();
      const first = await headOf(env, HEALTH);
      let n = 0;
      const readers: SourceReaderPort = {
        async read(key, scope) {
          const read = await env.readers.read(key, scope);
          if (key !== HEALTH) return read;
          n += 1;
          const value = read.normalizedValue as Record<string, unknown>;
          // every read races with a tool that registers something newer
          await sleep(5);
          await toolRegisters(env, { ...value, status: `newer-${n}` }, first.missionId);
          return { ...read, normalizedValue: { ...value, status: `sample-${n}` } };
        },
      };
      const [outcome] = await env.watcher({ readers }).observe([HEALTH]);
      expect(outcome).toMatchObject({ outcome: 'rejected' });
      // only the tools' readings were registered
      const rows = await observedAts(env, HEALTH);
      expect(rows.every((r, i) => i === 0 || r.status?.startsWith('newer-'))).toBe(true);
    });
  });
});
