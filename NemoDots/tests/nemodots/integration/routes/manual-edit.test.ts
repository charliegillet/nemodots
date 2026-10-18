// POST /sandbox/sources/:key: the owner manual edit through watcher/manual.ts
// (version authority, actor 'owner', immediate observation) over real
// PostgreSQL, the real source readers and the real watcher.
import { describe, expect, it } from 'vitest';
import { SourceEditResponseSchema } from '../../../../src/server/nemodots/contracts/index.js';
import { createOwnerEdit } from '../../../../src/server/nemodots/watcher/index.js';
import { configState, receiptsOf, withWatcherEnv } from '../watcher/harness.js';
import { mountRoutes } from './harness.js';

const member = (key: string) => `checkout.config/${key}`;

describe('manual source edit', () => {
  it('advances the version, answers {key, version} and registers a receipt immediately', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher({ config: { intervalMs: 60_000 } });
      await watcher.start();
      await watcher.runCycle();
      const r = mountRoutes(
        { pool: env.app, coordinator: env.coordinator, db: env.s.db },
        { ownerEdit: createOwnerEdit({ pool: env.app, watcher }) },
      );
      const before = await receiptsOf(env, member('ui.banner_text'));
      expect(before.map((x) => [x.revision, x.status])).toEqual([
        [1, 'supported'],
      ]);

      const response = await r.post('/sandbox/sources/ui.banner_text', {
        value: 'Hello from the route',
        expectedVersion: 1,
      });
      expect(response.status).toBe(200);
      expect(SourceEditResponseSchema.parse(await response.json())).toEqual({
        key: member('ui.banner_text'),
        version: 2,
      });

      const receipts = await receiptsOf(env, member('ui.banner_text'));
      expect(receipts.map((x) => [x.revision, x.status])).toEqual([
        [1, 'superseded'],
        [2, 'supported'],
      ]);
      expect(receipts[1]).toMatchObject({
        provenanceKind: 'owner_edit',
        selfWrite: 'none',
      });
      const state = await configState(env, 'ui.banner_text');
      expect(JSON.stringify(state)).toContain('Hello from the route');

      // the client sends the member key or the source key, URL-encoded
      const again = await r.post(
        `/sandbox/sources/${encodeURIComponent(member('ui.banner_text'))}`,
        { value: 'Second edit', expectedVersion: 2 },
      );
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({
        key: member('ui.banner_text'),
        version: 3,
      });
      r.close();
    });
  });

  it('a stale expectedVersion is 409 and changes nothing', async () => {
    await withWatcherEnv(async (env) => {
      const watcher = env.watcher({ config: { intervalMs: 60_000 } });
      await watcher.start();
      await watcher.runCycle();
      const r = mountRoutes(
        { pool: env.app, coordinator: env.coordinator, db: env.s.db },
        { ownerEdit: createOwnerEdit({ pool: env.app, watcher }) },
      );
      const before = await receiptsOf(env, member('ui.banner_text'));
      const response = await r.post('/sandbox/sources/ui.banner_text', {
        value: 'Late edit',
        expectedVersion: 7,
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(
        /Version conflict/,
      );
      expect(await receiptsOf(env, member('ui.banner_text'))).toEqual(before);
      r.close();
    });
  });

  it('rejects unknown keys, out-of-domain values and extra body fields before touching the edit', async () => {
    await withWatcherEnv(async (env) => {
      let calls = 0;
      const r = mountRoutes(
        { pool: env.app, coordinator: env.coordinator, db: env.s.db },
        {
          ownerEdit: async () => {
            calls += 1;
            throw new Error('must not be reached');
          },
        },
      );
      const cases: [string, unknown][] = [
        ['not.a.config.key', { value: 'x', expectedVersion: 1 }],
        ['orders.write_enabled', { value: 'yes', expectedVersion: 1 }],
        ['ui.banner_text', { value: 'x', expectedVersion: -1 }],
        ['ui.banner_text', { value: { nested: true }, expectedVersion: 1 }],
        [
          'ui.banner_text',
          { value: 'x', expectedVersion: 1, actor: 'injector' },
        ],
        ['ui.banner_text', { expectedVersion: 1 }],
      ];
      for (const [key, body] of cases) {
        const response = await r.post(`/sandbox/sources/${key}`, body);
        expect(response.status, `${key} ${JSON.stringify(body)}`).toBe(400);
      }
      expect(calls).toBe(0);
      r.close();
    });
  });
});
