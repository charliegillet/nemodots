// Gate 1 items 1-5 and 11-13: guarantees the oracle sequences do not reach
// directly, attacked on real PostgreSQL. Each test names its TEST_PROMPT item
// as [G1.n]. Where a test encodes a requirement the contract states only
// implicitly, the comment says which sentence of TEST_PROMPT it comes from.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  citationsOutOfScope,
  compileContext,
} from '../../../../src/server/nemodots/context/index.js';
import type { ContextSnapshotId } from '../../../../src/server/nemodots/contracts/index.js';
import { barrier, withTimeout } from '../../helpers/barrier.js';
import { CONF, REC, SRC, TRANS, World, errorCode } from './driver.js';
import { entry, withAccDatabase } from './harness.js';
import { realPageEdit } from './page-edit.js';

type Fixture = (w: World) => Promise<void>;
async function inDb(fn: Fixture) {
  await withAccDatabase(async (db) => {
    const w = new World(db);
    try {
      await fn(w);
    } finally {
      await w.close();
    }
  });
}

const HEALTH_OK = {
  status: 'ok',
  checks: { postgres: true, redis: true, config_parse: true, writes: true },
  errorClasses: [],
};
const HEALTH_BAD = {
  status: 'degraded',
  checks: { postgres: true, redis: true, config_parse: true, writes: false },
  errorClasses: ['writes_disabled'],
};

type RegisterFn = (
  client: pg.PoolClient,
  input: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<unknown>;
const registerFn = () =>
  entry<RegisterFn>('ledger/receipts.ts', ['registerObservation']);

/** Registers through the production path with a hand-built input; returns the error code or null. */
async function rawRegister(
  w: World,
  input: Record<string, unknown>,
  options?: Record<string, unknown>,
): Promise<string | null> {
  const register = await registerFn();
  try {
    await w.inTx((client) => register(client, input, options));
    return null;
  } catch (error) {
    return errorCode(error);
  }
}
const observed = (
  w: World,
  key: string,
  value: unknown,
  over: Record<string, unknown> = {},
  scope: Record<string, unknown> = {},
) => ({
  source: {
    ...w.sourceRef(key, 'test'),
    scope: { ...w.scope('test'), ...scope },
  },
  normalizedValue: value,
  provenance: { kind: 'watcher' },
  ...over,
});

// ------------------------------------------------------------------ item 1

describe('[G1.1] immutable receipt identity and safe failure', () => {
  it('[G1.1] the app role cannot rewrite or delete any identity column of a receipt, nor the confirmation and transition history', async () => {
    await inDb(async (w) => {
      const first = await w.register({
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      });
      expect(first.ok, first.error).toBe(true);
      await w.register({
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      }); // appends a confirmation
      await w.register({
        op: 'register',
        label: 'h2',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_BAD,
      }); // supersedes h1
      const id = w.labels.get('h1')!;
      const identityColumns = [
        'id',
        'source_id',
        'source_revision',
        'content_digest',
        'normalized_value',
        'observed_at',
        'trust',
        'supersedes',
      ];
      const attempts: string[] = [];
      for (const column of identityColumns) {
        const col = await w.schema.pick(REC, [column]);
        if (!col) continue;
        const before = (
          await w.admin.query(
            `SELECT "${col}"::text AS v FROM ${REC} WHERE id = $1`,
            [id],
          )
        ).rows[0]?.v;
        const update =
          col === 'id'
            ? `"${col}" = gen_random_uuid()`
            : col.endsWith('revision')
              ? `"${col}" = "${col}" + 50`
              : col === 'normalized_value'
                ? `"${col}" = '{"x":1}'::jsonb`
                : col === 'observed_at'
                  ? `"${col}" = now()`
                  : col === 'trust'
                    ? `"${col}" = 'probe'`
                    : col === 'supersedes'
                      ? `"${col}" = NULL`
                      : `"${col}" = repeat('0', 64)`;
        await w.app
          .query(`UPDATE ${REC} SET ${update} WHERE id = $1`, [id])
          .catch(() => {});
        const after = (
          await w.admin.query(
            `SELECT "${col}"::text AS v FROM ${REC} WHERE id = $1`,
            [id],
          )
        ).rows[0]?.v;
        if (before !== after) attempts.push(col);
      }
      expect(attempts, 'columns the app role managed to change').toEqual([]);
      await w.app
        .query(`DELETE FROM ${REC} WHERE id = $1`, [id])
        .catch(() => {});
      expect((await w.receiptById(id))?.id, 'receipt row was deleted').toBe(id);

      const rc = await w.schema.need(CONF, ['receipt_id']);
      const confBefore = (
        await w.admin.query(`SELECT count(*)::int AS n FROM ${CONF}`)
      ).rows[0].n;
      expect(confBefore).toBeGreaterThanOrEqual(1);
      await w.app
        .query(`DELETE FROM ${CONF} WHERE "${rc}" = $1`, [id])
        .catch(() => {});
      await w.app.query(`UPDATE ${CONF} SET "${rc}" = "${rc}"`).catch(() => {});
      expect(
        (await w.admin.query(`SELECT count(*)::int AS n FROM ${CONF}`)).rows[0]
          .n,
        'confirmations are append-only',
      ).toBe(confBefore);
      const trBefore = (
        await w.admin.query(`SELECT count(*)::int AS n FROM ${TRANS}`)
      ).rows[0].n;
      await w.app.query(`DELETE FROM ${TRANS}`).catch(() => {});
      expect(
        (await w.admin.query(`SELECT count(*)::int AS n FROM ${TRANS}`)).rows[0]
          .n,
        'transition history is append-only',
      ).toBe(trBefore);
    });
  });

  it('[G1.1] malformed observations fail safely: a typed refusal, nothing written, no crash', async () => {
    await inDb(async (w) => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      let deep: unknown = 1;
      for (let i = 0; i < 400; i += 1) deep = { d: deep };
      const huge = { items: Array.from({ length: 20_000 }, (_, i) => i) };
      const good = observed(w, 'checkout.metrics', {
        errorClasses: [],
        cacheHitDecile: 9,
        errorRateDecile: 0,
      });
      const bad: [string, Record<string, unknown>][] = [
        ['source null', { ...good, source: null }],
        [
          'source without key',
          { ...good, source: { ...good.source, key: undefined } },
        ],
        [
          'key with trailing newline',
          observed(w, 'checkout.health\n', HEALTH_OK),
        ],
        ['300 character key', observed(w, `runbook/${'a'.repeat(300)}`, {})],
        [
          'unknown environment',
          {
            ...good,
            source: {
              ...good.source,
              scope: { ...good.source.scope, environment: 'prod' },
            },
          },
        ],
        [
          'non-uuid mission',
          {
            ...good,
            source: {
              ...good.source,
              scope: { ...good.source.scope, missionId: 'not-a-uuid' },
            },
          },
        ],
        [
          'empty owner',
          {
            ...good,
            source: {
              ...good.source,
              scope: { ...good.source.scope, ownerId: '' },
            },
          },
        ],
        ['undefined value', { ...good, normalizedValue: undefined }],
        ['NaN value', { ...good, normalizedValue: { n: NaN } }],
        ['Infinity value', { ...good, normalizedValue: { n: Infinity } }],
        ['bigint value', { ...good, normalizedValue: { n: 1n } }],
        ['circular value', { ...good, normalizedValue: circular }],
        ['NUL character', { ...good, normalizedValue: { s: 'a\u0000b' } }],
        ['over 16 KiB array', { ...good, normalizedValue: huge }],
        [
          'claimed digest of the wrong type',
          { ...good, claimed: { contentDigest: 12345 } },
        ],
        [
          'claimed revision negative',
          { ...good, claimed: { sourceRevision: -1 } },
        ],
        [
          'selfWrite without an action id',
          { ...good, provenance: { kind: 'watcher', selfWrite: 'verified' } },
        ],
        [
          'unknown provenance kind',
          { ...good, provenance: { kind: 'telepathy' } },
        ],
        ['invalid observedAt', { ...good, observedAt: 'not a time' }],
      ];
      void deep;
      for (const [name, input] of bad) {
        const before = await w.totalReceipts();
        const sources = await w.distinctSources();
        const started = Date.now();
        const code = await rawRegister(w, input);
        expect(code, `${name}: must be refused`).not.toBeNull();
        expect(code, `${name}: crash instead of a typed refusal`).not.toMatch(
          /^unclassified:(TypeError|RangeError|ReferenceError)/,
        );
        expect(
          Date.now() - started,
          `${name}: refusal took too long`,
        ).toBeLessThan(5_000);
        expect(
          await w.totalReceipts(),
          `${name}: a refused observation wrote a receipt`,
        ).toBe(before);
        expect(
          await w.distinctSources(),
          `${name}: a refused observation created a source`,
        ).toBe(sources);
      }
      // The same connection pool still works afterwards.
      const ok = await w.register({
        op: 'register',
        label: 'ok',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      });
      expect(ok.ok, ok.error).toBe(true);
    });
  });
});

// ------------------------------------------------------------------ item 2

describe('[G1.2] scope isolation of sources', () => {
  it('[G1.2] the same key under another environment, resource, owner or Space is a different source with its own revisions', async () => {
    await inDb(async (w) => {
      const variants: [string, Record<string, unknown>][] = [
        ['base', {}],
        ['other environment', { environment: 'eval' }],
        ['other resource', { resource: 'checkout-shadow' }],
        ['other owner', { ownerId: 'acc1-someone-else' }],
        ['other Space', { spaceId: 'space-b' }],
      ];
      const results: string[] = [];
      for (const [name, scope] of variants) {
        const value = { ...HEALTH_OK, errorClasses: [name] };
        const code = await rawRegister(
          w,
          observed(w, 'checkout.health', value, {}, scope),
        );
        results.push(`${name}:${code ?? 'ok'}`);
      }
      expect(
        results.every((r) => r.endsWith(':ok')),
        results.join(', '),
      ).toBe(true);
      expect(
        await w.distinctSources(),
        'five scopes must be five sources',
      ).toBe(5);
      const rows = await w.admin
        .query(`SELECT s.id AS sid, count(*)::int AS n, max(r.source_revision)::int AS rev, max(r.status) AS status
                                          FROM ${REC} r JOIN ${SRC} s ON s.id = r.source_id GROUP BY s.id`);
      expect(rows.rows.map((r) => [r.n, r.rev, r.status])).toEqual(
        Array(5).fill([1, 1, 'supported']),
      );
    });
  });

  it('[G1.2] a registration in one scope never supersedes, confirms or invalidates another scope', async () => {
    await inDb(async (w) => {
      await w.register({
        op: 'register',
        label: 'a',
        sourceKey: 'checkout.health',
        environment: 'test',
        normalizedValue: HEALTH_OK,
      });
      await w.register({
        op: 'register',
        label: 'b',
        sourceKey: 'checkout.health',
        environment: 'eval',
        normalizedValue: HEALTH_BAD,
      });
      // Same value as test's receipt, observed in eval: must not append a confirmation to test's receipt.
      const r = await w.register({
        op: 'register',
        label: 'b2',
        sourceKey: 'checkout.health',
        environment: 'eval',
        normalizedValue: HEALTH_OK,
      });
      expect(r.ok, r.error).toBe(true);
      expect((await w.receiptById(w.labels.get('a')!))?.status).toBe(
        'supported',
      );
      expect(
        await w.confirmationCount(w.labels.get('a')!),
        'test receipt confirmed by an eval observation',
      ).toBe(0);
      expect((await w.currentOf('eval', 'checkout.health'))?.revision).toBe(2);
      expect((await w.currentOf('test', 'checkout.health'))?.revision).toBe(1);
    });
  });

  it('[G1.2] a receipt of another environment is not a valid citation for the emitting call (no access granted)', () => {
    const uid = (n: number) =>
      `b1b2b3b4-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const mine = {
      sourceKey: 'checkout.health',
      sourceRevision: 1,
      receiptId: uid(1),
    };
    const foreign = uid(2);
    const compiled = compileContext({
      snapshotId: uid(9) as ContextSnapshotId,
      layout: 'cache_aware',
      nowIso: '2026-10-17T18:00:00.000Z',
      commonInstructions: 'x',
      roleInstructions: 'y',
      task: { title: 't', question: 'q' },
      runbooks: [],
      receipts: [],
      inheritedArtifacts: [],
      pageSnapshots: [],
      memories: [],
      invalidations: [],
      history: [],
      readSetVector: [mine],
    } as never);
    const outside = citationsOutOfScope(
      [mine.receiptId, foreign],
      compiled.snapshot,
      { readSetReceiptIds: [], inheritedDependencyVector: [] } as never,
    );
    expect(outside).toEqual([foreign]);
  });
});

// ------------------------------------------------------------------ item 3

describe('[G1.3] supersession and support status', () => {
  it('[G1.3] contested resolves back to supported; retracted and expired never regain support', async () => {
    await inDb(async (w) => {
      const transitionReceipt = await entry<
        (c: pg.PoolClient, i: Record<string, unknown>) => Promise<unknown>
      >('ledger/receipts.ts', ['transitionReceipt']);
      const mk = async (label: string, key: string, value: unknown) => {
        const r = await w.register({
          op: 'register',
          label,
          sourceKey: key,
          normalizedValue: value,
        });
        expect(r.ok, r.error).toBe(true);
        return w.labels.get(label)!;
      };
      const h = await mk('h', 'checkout.health', HEALTH_OK);
      const m = await mk('m', 'checkout.metrics', {
        errorClasses: [],
        cacheHitDecile: 9,
        errorRateDecile: 0,
      });
      await w.transition({ op: 'transition', label: 'h', to: 'contested' });
      expect((await w.receiptById(h))?.status).toBe('contested');
      expect(
        (
          await w.assertCurrent({
            op: 'assert_current',
            labels: ['h'],
            lockMode: 'share',
          })
        ).error,
      ).toBe('receipt_not_supported');
      await w.inTx((c) =>
        transitionReceipt(c, {
          receiptId: h,
          to: 'supported',
          reason: 'resolved',
        }),
      );
      expect(
        (
          await w.assertCurrent({
            op: 'assert_current',
            labels: ['h'],
            lockMode: 'share',
          })
        ).ok,
      ).toBe(true);

      await w.transition({ op: 'transition', label: 'm', to: 'retracted' });
      const back = await w
        .inTx((c) =>
          transitionReceipt(c, {
            receiptId: m,
            to: 'supported',
            reason: 'resolved',
          }),
        )
        .then(
          () => 'accepted',
          (e) => errorCode(e),
        );
      expect(back, 'a retracted receipt came back to supported').not.toBe(
        'accepted',
      );
      expect((await w.receiptById(m))?.status).toBe('retracted');
    });
  });

  it('[G1.3] the app role cannot resurrect a superseded receipt by writing its status', async () => {
    await inDb(async (w) => {
      await w.register({
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      });
      await w.register({
        op: 'register',
        label: 'h2',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_BAD,
      });
      const old = w.labels.get('h1')!;
      expect((await w.receiptById(old))?.status).toBe('superseded');
      await w.app
        .query(`UPDATE ${REC} SET status = 'supported' WHERE id = $1`, [old])
        .catch(() => {});
      expect(
        (await w.receiptById(old))?.status,
        'old revision resurrected by direct update',
      ).toBe('superseded');
      await w.app
        .query(`UPDATE ${REC} SET status = 'contested' WHERE id = $1`, [old])
        .catch(() => {});
      expect((await w.receiptById(old))?.status).toBe('superseded');
    });
  });
});

// ------------------------------------------------------------------ item 4

describe('[G1.4] out-of-order delivery and ABA', () => {
  it('[G1.4] observed ABA: ok -> degraded -> ok mints revision 3, old ok stays superseded', async () => {
    await inDb(async (w) => {
      for (const [label, value] of [
        ['a1', HEALTH_OK],
        ['b', HEALTH_BAD],
        ['a2', HEALTH_OK],
      ] as const) {
        const r = await w.register({
          op: 'register',
          label,
          sourceKey: 'checkout.health',
          normalizedValue: value,
        });
        expect(r.ok, r.error).toBe(true);
      }
      expect((await w.currentOf('test', 'checkout.health'))?.revision).toBe(3);
      expect((await w.receiptById(w.labels.get('a1')!))?.status).toBe(
        'superseded',
      );
      expect((await w.receiptById(w.labels.get('a2')!))?.id).not.toBe(
        w.labels.get('a1'),
      );
      expect(
        (
          await w.assertCurrent({
            op: 'assert_current',
            labels: ['a1'],
            lockMode: 'update',
          })
        ).ok,
      ).toBe(false);
    });
  });

  it('[G1.4] a delayed claim of an old observed revision is rejected and writes nothing', async () => {
    await inDb(async (w) => {
      await w.register({
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      });
      await w.register({
        op: 'register',
        label: 'h2',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_BAD,
      });
      const before = await w.totalReceipts();
      const code = await rawRegister(
        w,
        observed(w, 'checkout.health', HEALTH_OK, {
          claimed: { sourceRevision: 1 },
        }),
      );
      expect(code).toBe('stale_observation_rejected');
      expect(await w.totalReceipts()).toBe(before);
      expect((await w.currentOf('test', 'checkout.health'))?.revision).toBe(2);
    });
  });

  it('[G1.4][G1.3] two registrations parked after the preliminary read (C8 race): exactly one new revision, the other confirms', async () => {
    await inDb(async (w) => {
      await w.register({
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      });
      const register = await registerFn();
      const gate = barrier(2);
      // Ordered log of what happened: both writers must ARRIVE at the post-read barrier before either COMMITS.
      const log: string[] = [];
      let hookCalls = 0;
      const options = {
        hooks: {
          afterPreliminaryRead: async () => {
            hookCalls += 1;
            log.push('arrive');
            await withTimeout(
              gate.arrive(),
              10_000,
              'both writers must reach the preliminary-read barrier',
            );
          },
        },
      };
      const input = observed(w, 'checkout.health', HEALTH_BAD);
      const run = () =>
        w
          .inTx((c) => register(c, structuredClone(input), options))
          .then(() => log.push('commit'));
      const outcomes = await Promise.allSettled([run(), run()]);
      expect(
        outcomes.map((o) => o.status),
        outcomes
          .map((o) => (o.status === 'rejected' ? errorCode(o.reason) : 'ok'))
          .join(','),
      ).toEqual(['fulfilled', 'fulfilled']);
      // A hook production never calls (or gates behind NEMODOTS_TEST_HOOKS) would make this an unforced race.
      expect(
        hookCalls,
        'afterPreliminaryRead must run once per registration',
      ).toBe(2);
      expect(gate.arrived).toBe(2);
      expect(
        log.slice(0, 2),
        'both registrations must reach the barrier before either commits',
      ).toEqual(['arrive', 'arrive']);
      expect(log.slice(2)).toEqual(['commit', 'commit']);
      const rows = await w.receiptsOf('test', 'checkout.health');
      expect(rows.map((r) => r.revision)).toEqual([1, 2]);
      expect(rows.map((r) => r.status)).toEqual(['superseded', 'supported']);
      expect(
        await w.confirmationCount(rows[1].id),
        'the loser must append exactly one confirmation',
      ).toBe(1);
    });
  });

  it('[G1.4] eight concurrent registrations of one new digest still mint one revision', async () => {
    await inDb(async (w) => {
      await w.register({
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      });
      const register = await registerFn();
      const input = observed(w, 'checkout.health', HEALTH_BAD);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          w.inTx((c) => register(c, structuredClone(input))),
        ),
      );
      expect(
        results
          .filter((r) => r.status === 'rejected')
          .map((r) => errorCode((r as PromiseRejectedResult).reason)),
      ).toEqual([]);
      const rows = await w.receiptsOf('test', 'checkout.health');
      expect(rows).toHaveLength(2);
      expect(await w.confirmationCount(rows[1].id)).toBe(7);
    });
  });
});

// ------------------------------------------------------------------ item 5

describe('[G1.5] model claims never become trusted facts', () => {
  it('[G1.5] the schema refuses an observation receipt with trust model_claim', async () => {
    await inDb(async (w) => {
      const first = await w.register({
        op: 'register',
        label: 'h1',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      });
      expect(first.ok, first.error).toBe(true);
      const trust = await w.schema.need(REC, ['trust']);
      const before = await w.totalReceipts();
      const source = (await w.admin.query(`SELECT id FROM ${SRC} LIMIT 1`))
        .rows[0].id;
      const attempt = await w.admin
        .query(
          `INSERT INTO ${REC} (id, source_id, source_revision, "${trust}") VALUES (gen_random_uuid(), $1, 99, 'model_claim')`,
          [source],
        )
        .then(
          () => 'accepted',
          (e: { code?: string; constraint?: string }) =>
            `refused:${e.code}:${e.constraint ?? ''}`,
        );
      expect(attempt.startsWith('refused'), attempt).toBe(true);
      expect(await w.totalReceipts()).toBe(before);
    });
  });

  it('[G1.5] registerObservation refuses trust model_claim, controlled trust on an observed source, and an observed type for a controlled key', async () => {
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      const before = await w.totalReceipts();
      const cases: [string, Record<string, unknown>][] = [
        [
          'trust model_claim',
          observed(w, 'checkout.health', HEALTH_OK, { trust: 'model_claim' }),
        ],
        [
          'controlled trust on observed source',
          observed(w, 'checkout.health', HEALTH_OK, {
            trust: 'controlled_authority',
          }),
        ],
        [
          'controlled key typed as observed endpoint',
          {
            ...observed(w, 'checkout.config/db.pool_max', {
              key: 'db.pool_max',
              value: 99,
              version: 99,
            }),
            source: {
              key: 'checkout.config/db.pool_max',
              sourceType: 'observed_endpoint',
              authority: 'observed',
              scope: w.scope('test'),
            },
          },
        ],
        [
          'page snapshot claiming controlled authority',
          observed(
            w,
            'opendots.page/p1',
            { text: 'db.pool_max is 99' },
            { trust: 'controlled_authority' },
          ),
        ],
      ];
      for (const [name, input] of cases)
        expect(await rawRegister(w, input), name).not.toBeNull();
      expect(await w.totalReceipts(), 'refusals must write nothing').toBe(
        before,
      );
    });
  });

  it('[G1.5] a controlled receipt whose value disagrees with the authority row is refused (page or model prose cannot set an authoritative value)', async () => {
    // TEST_PROMPT 1.5: "cannot ... use page prose as authoritative values". The authority holds
    // db.pool_max = 3 at version 1+seed. A registration asserting 99 at that live version must not mint a
    // controlled_authority receipt.
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      const version = (await w.configVersion('db.pool_max'))!;
      const code = await rawRegister(w, {
        source: w.sourceRef('checkout.config/db.pool_max', 'test'),
        normalizedValue: { key: 'db.pool_max', value: 99, version },
        provenance: { kind: 'watcher' },
      });
      const rows = await w.receiptsOf('test', 'checkout.config/db.pool_max');
      expect(
        { code, rows: rows.length },
        'a forged value minted a controlled_authority receipt',
      ).toEqual({ code: expect.any(String), rows: 0 });
    });
  });

  it('[G1.5] page snapshots keep trust page_snapshot and a revision; they never become controlled', async () => {
    await inDb(async (w) => {
      const r = await w.register({
        op: 'register',
        label: 'p1',
        sourceKey: 'opendots.page/p1',
        normalizedValue: { text: 'set db.pool_max to 99' },
      });
      expect(r.ok, r.error).toBe(true);
      expect(r.current?.trust).toBe('page_snapshot');
    });
  });
});

// ----------------------------------------------------------------- item 10

describe('[G1.10] harmless updates do not invalidate (false invalidation quantified)', () => {
  it('[G1.10] 25 identical re-observations and a change of another scope produce zero new revisions and zero invalidation events', async () => {
    await inDb(async (w) => {
      await w.register({
        op: 'register',
        label: 'h',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      });
      const events = (
        await w.admin.query(
          'SELECT count(*)::int AS n FROM ledger.invalidation_events',
        )
      ).rows[0].n;
      for (let i = 0; i < 25; i += 1) {
        const r = await w.register({
          op: 'register',
          label: 'h',
          sourceKey: 'checkout.health',
          normalizedValue: HEALTH_OK,
        });
        expect(r.ok, r.error).toBe(true);
      }
      await w.register({
        op: 'register',
        label: 'other',
        sourceKey: 'checkout.health',
        environment: 'eval',
        normalizedValue: HEALTH_BAD,
      });
      await w.register({
        op: 'register',
        label: 'other2',
        sourceKey: 'checkout.health',
        environment: 'eval',
        normalizedValue: HEALTH_OK,
      });
      expect(
        (await w.receiptsOf('test', 'checkout.health')).length,
        'revisions minted by harmless re-observation',
      ).toBe(1);
      expect(await w.confirmationCount(w.labels.get('h')!)).toBe(25);
      const after = (
        await w.admin.query(
          "SELECT count(*)::int AS n, count(*) FILTER (WHERE source_key = 'checkout.health')::int AS m FROM ledger.invalidation_events",
        )
      ).rows[0];
      // The eval scope's first receipt has no predecessor; its second supersedes one (nothing depends on it): one event, in its own scope.
      expect(after.n - events, 'events caused by the eval scope only').toBe(1);
      expect(
        (await w.receiptById(w.labels.get('h')!))?.status,
        'test scope receipt must stay current',
      ).toBe('supported');
    });
  });
});

// ----------------------------------------------------------------- item 11

describe('[G1.11] page edits and ledger values', () => {
  it('[G1.11] a real page edit mints exactly one page_snapshot revision of its own source and leaves every controlled value, history row and receipt alone', async () => {
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      const pool = await w.register({
        op: 'register',
        label: 'pool',
        sourceKey: 'checkout.config/db.pool_max',
      });
      expect(pool.ok, pool.error).toBe(true);
      const versionBefore = await w.configVersion('db.pool_max');
      // Throws ENTRY POINT MISSING while the page store has no onRevision hook.
      const report = await realPageEdit(w, 'p1');
      expect(
        report.problems,
        'page edit through the real OpenDots page store',
      ).toEqual([]);
      expect(report.revisionsAfter - report.revisionsBefore).toBe(1);
      expect(report.hookEvents).toBe(1);
      expect(
        (await w.receiptById(w.labels.get('pool')!))?.status,
        'a page edit invalidated a controlled receipt',
      ).toBe('supported');
      expect(await w.configVersion('db.pool_max')).toBe(versionBefore);
      expect(await w.configValue('db.pool_max')).toBe(3);
    });
  });

  it('[G1.11] a consumer that read a page snapshot records its page, revision and digest in its context lineage', () => {
    const uid = (n: number) =>
      `c9c8c7c6-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const c = compileContext({
      snapshotId: uid(1) as ContextSnapshotId,
      layout: 'cache_aware',
      nowIso: '2026-10-17T18:00:00.000Z',
      commonInstructions: 'x',
      roleInstructions: 'y',
      task: { title: 't', question: 'q' },
      runbooks: [],
      receipts: [],
      inheritedArtifacts: [],
      pageSnapshots: [
        {
          pageId: 'p1',
          revision: 7,
          text: 'the page as read',
          dependencyVector: [
            {
              sourceKey: 'opendots.page/p1',
              sourceRevision: 7,
              receiptId: uid(5),
            },
          ],
        },
      ],
      memories: [],
      invalidations: [],
      history: [],
    } as never);
    expect(c.snapshot.injected.pageSnapshots).toEqual([
      expect.objectContaining({
        pageId: 'p1',
        revision: 7,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
    expect(c.snapshot.dependencyVector.map((d) => d.receiptId)).toContain(
      uid(5),
    );
  });
});

// ----------------------------------------------------------------- item 12

describe('[G1.12] absence is evidence with a collection epoch', () => {
  it('[G1.12] a negative membership receipt is invalidated by inserting the key it said was absent', async () => {
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      const version = await w.collectionVersion();
      const keys = (
        await w.admin.query(
          'SELECT key FROM checkout.config_entries ORDER BY key',
        )
      ).rows.map((r) => r.key);
      const code = await rawRegister(w, {
        source: w.sourceRef('checkout.config', 'test'),
        normalizedValue: { keys, collectionVersion: version },
        negative: {
          predicate: "key 'checkout.restrict_orders' does not exist",
          collectionRevision: version,
        },
        provenance: { kind: 'watcher' },
      });
      expect(code, 'registering a negative collection receipt').toBeNull();
      const cur = (await w.currentOf('test', 'checkout.config'))!;
      w.labels.set('absence', cur.id);

      expect(
        (
          await w.assertCurrent({
            op: 'assert_current',
            labels: ['absence'],
            lockMode: 'share',
          })
        ).ok,
        'absence holds before the insert',
      ).toBe(true);
      await w.advance({
        op: 'advance_config',
        key: 'checkout.restrict_orders',
        value: true,
        actor: 'injector',
        insertIfMissing: true,
      });
      // Before the watcher registers anything: the old absence observation is already unusable.
      const pending = await w.assertCurrent({
        op: 'assert_current',
        labels: ['absence'],
        lockMode: 'share',
      });
      expect(pending.error).toBe('stale_pending_observation');
      const reg = await w.register({
        op: 'register',
        label: 'after',
        sourceKey: 'checkout.config',
      });
      expect(reg.ok, reg.error).toBe(true);
      const late = await w.assertCurrent({
        op: 'assert_current',
        labels: ['absence'],
        lockMode: 'update',
      });
      expect(late.error).toBe('stale_version');
    });
  });

  it('[G1.12] a value update of an existing key leaves the absence observation current (no false invalidation)', async () => {
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      const version = await w.collectionVersion();
      const code = await rawRegister(w, {
        source: w.sourceRef('checkout.config', 'test'),
        normalizedValue: { keys: ['db.pool_max'], collectionVersion: version },
        negative: {
          predicate: "key 'checkout.restrict_orders' does not exist",
          collectionRevision: version,
        },
        provenance: { kind: 'watcher' },
      });
      expect(code).toBeNull();
      w.labels.set(
        'absence',
        (await w.currentOf('test', 'checkout.config'))!.id,
      );
      await w.advance({
        op: 'advance_config',
        key: 'db.pool_max',
        value: 8,
        actor: 'injector',
      });
      expect(
        (
          await w.assertCurrent({
            op: 'assert_current',
            labels: ['absence'],
            lockMode: 'update',
          })
        ).ok,
      ).toBe(true);
    });
  });
});

// ----------------------------------------------------------------- item 13

describe('[G1.13] authority advanced before the watcher has processed it', () => {
  it('[G1.13] every receipt of a mixed vector is checked: one pending-stale member fails the whole vector in both lock modes', async () => {
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      await w.register({
        op: 'register',
        label: 'pool',
        sourceKey: 'checkout.config/db.pool_max',
      });
      await w.register({
        op: 'register',
        label: 'health',
        sourceKey: 'checkout.health',
        normalizedValue: HEALTH_OK,
      });
      expect(
        (
          await w.assertCurrent({
            op: 'assert_current',
            labels: ['pool', 'health'],
            lockMode: 'share',
          })
        ).ok,
      ).toBe(true);
      await w.advance({
        op: 'advance_config',
        key: 'db.pool_max',
        value: 7,
        actor: 'injector',
      });
      for (const lockMode of ['share', 'update'] as const) {
        const r = await w.assertCurrent({
          op: 'assert_current',
          labels: ['pool', 'health'],
          lockMode,
        });
        expect(r.ok, `${lockMode}: a stale member must fail the vector`).toBe(
          false,
        );
        expect(r.error).toBe('stale_pending_observation');
      }
      // The fresh, unrelated receipt alone is still usable: stale premises do not poison other sources.
      expect(
        (
          await w.assertCurrent({
            op: 'assert_current',
            labels: ['health'],
            lockMode: 'share',
          })
        ).ok,
      ).toBe(true);
    });
  });

  it('[G1.13] share-locked support checks make a concurrent authority advance wait until the publication commits (observed in pg_stat_activity, not by timing)', async () => {
    await inDb(async (w) => {
      await w.seedConfig('db.pool_max', 3);
      await w.snapshotBases();
      await w.register({
        op: 'register',
        label: 'pool',
        sourceKey: 'checkout.config/db.pool_max',
      });
      const mod = await entry<Record<string, unknown>>('ledger/support.ts', [
        'assertCurrent',
        'supportValidator',
        'SupportValidator',
        'createSupportValidator',
      ]);
      const fn = await (
        w as unknown as {
          resolveAssertCurrent(
            m: unknown,
          ): Promise<
            (
              c: pg.PoolClient,
              ids: string[],
              o: Record<string, unknown>,
            ) => Promise<unknown>
          >;
        }
      ).resolveAssertCurrent(mod);
      const holder = await w.app.connect();
      const racerClient = await w.injector.connect();
      try {
        const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid as number;
        const racerPid = (
          await racerClient.query('SELECT pg_backend_pid() AS pid')
        ).rows[0].pid as number;
        await holder.query('BEGIN');
        await fn(holder, [w.labels.get('pool')!], { lockMode: 'share' });
        // The publication transaction is open and holds FOR SHARE on the controlled row.
        let advanced = false;
        const racer = w
          .advanceOn(racerClient, {
            op: 'advance_config',
            key: 'db.pool_max',
            value: 9,
            actor: 'injector',
          })
          .then(() => {
            advanced = true;
          });
        // Deterministic: wait until PostgreSQL itself reports the racer blocked by the holder's backend
        // (pg_blocking_pids works for any role; wait_event_type is hidden from non-superusers).
        const deadline = Date.now() + 15_000;
        let blockers: number[] = [];
        while (Date.now() < deadline) {
          const r = await w.admin.query(
            'SELECT pg_blocking_pids($1::int) AS blockers',
            [racerPid],
          );
          blockers = r.rows[0].blockers as number[];
          if (blockers.includes(holderPid)) break;
          if (advanced) break; // finished without ever waiting: no lock was taken
          await new Promise((res) => setTimeout(res, 25));
        }
        expect(
          advanced,
          'the authority advanced while a publication held its share lock',
        ).toBe(false);
        expect(
          blockers,
          'the advancing backend was never blocked by the publication transaction; the support check took no lock on the authority row',
        ).toContain(holderPid);
        const lockedRelations = await w.admin.query(
          `SELECT DISTINCT c.relname FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = $1 AND l.granted AND c.relname = 'config_entries'`,
          [holderPid],
        );
        expect(
          lockedRelations.rowCount,
          'the publication holds a lock on checkout.config_entries',
        ).toBe(1);
        await holder.query('COMMIT');
        await withTimeout(
          racer,
          10_000,
          'advance must proceed after the publication commits',
        );
        expect(advanced).toBe(true);
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        holder.release();
        racerClient.release();
      }
    });
  });
});
