// Polling and notification: controlled sources follow the authority, observed
// sources are confirmed or re-registered on every poll (I2/D2), membership-only
// collection semantics hold through the watcher (C1/D1).
import { expect, it } from 'vitest';
import type { SourceKey } from '../../../../src/server/nemodots/contracts/index.js';
import { listConfirmations } from '../../../../src/server/nemodots/ledger/index.js';
import { advanceConfigUnconditionallyTx } from '../../../../src/server/nemodots/sandbox/version-authority.js';
import { Injector } from '../../../../src/server/nemodots/sandbox/injector.js';
import { loadScenario } from '../../../../src/server/nemodots/sandbox/manifest.js';
import {
  claimStart,
  confirmationCount,
  plannedMission,
  receiptsOf,
  until,
  withWatcherEnv,
} from './harness.js';

const two = [
  { role: 'investigator' as const },
  { role: 'investigator' as const },
];

async function attemptStatus(
  env: Parameters<Parameters<typeof withWatcherEnv>[0]>[0],
  id: string,
) {
  const { rows } = await env.h.admin.query<{ status: string }>(
    'SELECT status FROM coordinator.task_attempts WHERE id = $1',
    [id],
  );
  return rows[0].status;
}

it('an injector change is registered within one poll, supersedes the old receipt and enumerates the affected sets per mission', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const m1 = await plannedMission(h, two);
    const m2 = await plannedMission(h, two);
    const a1 = await claimStart(h, { taskId: m1.taskIds[0] });
    const a2 = await claimStart(h, { taskId: m1.taskIds[1] });
    const b1 = await claimStart(h, { taskId: m2.taskIds[0] });

    const cache = await env.observeMember(m1.missionId, 'cache.schema_version');
    const pool = await env.observeMember(m1.missionId, 'db.pool_max');
    await env.link(cache.receipt.id, {
      attemptId: a1.context.attemptId,
      taskId: m1.taskIds[0],
      missionId: m1.missionId,
    });
    await env.link(cache.receipt.id, {
      attemptId: b1.context.attemptId,
      taskId: m2.taskIds[0],
      missionId: m2.missionId,
    });
    await env.link(pool.receipt.id, {
      attemptId: a2.context.attemptId,
      taskId: m1.taskIds[1],
      missionId: m1.missionId,
    });

    const watcher = env.make();
    // Nothing changed: a pass registers nothing.
    expect(await watcher.pass()).toMatchObject({ registered: 0, unchanged: 2 });

    // The real injector, the real scenario manifest.
    const run = await new Injector({
      pool: env.injector,
      listenUrl: h.db.urls.injector,
    }).start(loadScenario('cache_schema_mismatch'), 1);
    await run.done;

    const stats = await watcher.pass();
    expect(stats).toMatchObject({ registered: 1, unchanged: 1, errors: 0 });

    const revisions = await receiptsOf(
      h,
      'checkout.config/cache.schema_version',
    );
    expect(revisions.map((r) => [r.source_revision, r.status])).toEqual([
      [1, 'superseded'],
      [2, 'supported'],
    ]);
    expect(revisions[1]).toMatchObject({
      provenance_kind: 'watcher',
      self_write: 'none',
      caused_by_action_id: null,
    });
    // db.pool_max is untouched.
    expect(await receiptsOf(h, 'checkout.config/db.pool_max')).toHaveLength(1);

    // Hand-enumerated per-mission affected sets: a1 (mission 1) and b1
    // (mission 2); a2 read the other source and is not in the closure.
    expect(env.recovery.invalidations).toHaveLength(1);
    const event = env.recovery.invalidations[0];
    expect(event.sourceKey).toBe('checkout.config/cache.schema_version');
    expect(event.reason).toBe('newer_observation');
    const perMission = Object.fromEntries(
      event.perMission.map((entry) => [
        entry.missionId,
        entry.affected.attemptIds,
      ]),
    );
    expect(perMission).toEqual({
      [m1.missionId]: [a1.context.attemptId],
      [m2.missionId]: [b1.context.attemptId],
    });
    expect([...event.affected.attemptIds].sort()).toEqual(
      [a1.context.attemptId, b1.context.attemptId].sort(),
    );
    expect(await attemptStatus(env, a1.context.attemptId)).not.toBe('running');
    expect(await attemptStatus(env, b1.context.attemptId)).not.toBe('running');
    expect(await attemptStatus(env, a2.context.attemptId)).toBe('running');
  });
});

it('the NOTIFY path registers within 500 ms although the poll interval is a minute', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const m = await plannedMission(h, two);
    const attempt = await claimStart(h, { taskId: m.taskIds[0] });
    const rc = await env.observeMember(m.missionId, 'db.pool_max');
    await env.link(rc.receipt.id, {
      attemptId: attempt.context.attemptId,
      taskId: m.taskIds[0],
      missionId: m.missionId,
    });
    const watcher = env.make({ intervalMs: 60_000 });
    watcher.start();
    await until(async () => watcher.isLeader(), 'leadership');
    // The first tick has run; the next is a minute away.
    await until(
      async () => env.reader.reads === 0 && watcher.isLeader(),
      'first pass',
    );
    await new Promise((r) => setTimeout(r, 100));

    const t0 = Date.now();
    await env.inject('db.pool_max', 2);
    await until(
      async () =>
        (await receiptsOf(h, 'checkout.config/db.pool_max')).length === 2,
      'second revision',
      2_000,
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
    expect(
      env.recovery.invalidations.at(-1)?.perMission[0].affected.attemptIds,
    ).toEqual([attempt.context.attemptId]);
  });
});

it('an observed source unchanged over 5 polls mints no revision and appends 5 confirmations; lastConfirmedAt advances', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const m = await plannedMission(h, two);
    const first = await env.observeEndpoint(m.missionId, 'checkout.health', {
      status: 'ok',
      errors: [],
    });
    const watcher = env.make();
    let previous = first.receipt.lastConfirmedAt;
    for (let i = 1; i <= 5; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
      const stats = await watcher.pass();
      expect(stats).toMatchObject({ confirmed: 1, registered: 0 });
      const head = (await receiptsOf(h, 'checkout.health')).at(-1)!;
      expect(await confirmationCount(h, head.id)).toBe(i);
      const confirmations = await listConfirmations(h.pool, head.id);
      const latest = confirmations.at(-1)!.confirmedAt;
      expect(Date.parse(latest)).toBeGreaterThan(Date.parse(previous));
      previous = latest;
    }
    const receipts = await receiptsOf(h, 'checkout.health');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe('supported');
    expect(env.recovery.invalidations).toHaveLength(0);
  });
});

it('a changed health status registers exactly once and supersedes the old receipt', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const m = await plannedMission(h, two);
    const attempt = await claimStart(h, { taskId: m.taskIds[0] });
    const first = await env.observeEndpoint(m.missionId, 'checkout.health', {
      status: 'ok',
      errors: [],
    });
    await env.link(first.receipt.id, {
      attemptId: attempt.context.attemptId,
      taskId: m.taskIds[0],
      missionId: m.missionId,
    });
    const watcher = env.make();
    env.reader.values.set('checkout.health' as SourceKey, {
      status: 'degraded',
      errors: ['cache_decode_error'],
    });
    expect(await watcher.pass()).toMatchObject({ registered: 1 });
    expect(await watcher.pass()).toMatchObject({ registered: 0, confirmed: 1 });
    expect(await watcher.pass()).toMatchObject({ registered: 0, confirmed: 1 });
    const receipts = await receiptsOf(h, 'checkout.health');
    expect(receipts.map((r) => [r.source_revision, r.status])).toEqual([
      [1, 'superseded'],
      [2, 'supported'],
    ]);
    expect(env.recovery.invalidations).toHaveLength(1);
    expect(env.recovery.invalidations[0].affected.attemptIds).toEqual([
      attempt.context.attemptId,
    ]);
  });
});

it('a failing reader registers nothing and is logged; the next poll recovers', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const m = await plannedMission(h, two);
    await env.observeEndpoint(m.missionId, 'checkout.health', { status: 'ok' });
    const watcher = env.make();
    env.reader.failing = true;
    expect(await watcher.pass()).toMatchObject({ confirmed: 0, registered: 0 });
    expect(env.logs.some((l) => l.event === 'read_failed')).toBe(true);
    env.reader.failing = false;
    expect(await watcher.pass()).toMatchObject({ confirmed: 1 });
    expect(await receiptsOf(h, 'checkout.health')).toHaveLength(1);
  });
});

it('B1: a ui.banner_text change supersedes the member receipt only; the collection receipt stays current and a mission that never read the key is unaffected (C1/D1)', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const m = await plannedMission(h, two);
    const reader = await claimStart(h, { taskId: m.taskIds[0] });
    const bystander = await claimStart(h, { taskId: m.taskIds[1] });
    const banner = await env.observeMember(m.missionId, 'ui.banner_text');
    const collection = await env.observeCollection(m.missionId);
    const pool = await env.observeMember(m.missionId, 'db.pool_max');
    await env.link(collection.receipt.id, {
      attemptId: bystander.context.attemptId,
      taskId: m.taskIds[1],
      missionId: m.missionId,
    });
    await env.link(pool.receipt.id, {
      attemptId: bystander.context.attemptId,
      taskId: m.taskIds[1],
      missionId: m.missionId,
    });
    await env.link(banner.receipt.id, {
      attemptId: reader.context.attemptId,
      taskId: m.taskIds[0],
      missionId: m.missionId,
    });
    // a second mission that never read the banner
    const other = await plannedMission(h, two);
    const otherAttempt = await claimStart(h, { taskId: other.taskIds[0] });
    await env.link(pool.receipt.id, {
      attemptId: otherAttempt.context.attemptId,
      taskId: other.taskIds[0],
      missionId: other.missionId,
    });

    const run = await new Injector({
      pool: env.injector,
      listenUrl: h.db.urls.injector,
    }).start(loadScenario('benign_change'), 1);
    await run.done;
    const watcher = env.make();
    expect(await watcher.pass()).toMatchObject({ registered: 1, errors: 0 });

    expect(
      (await receiptsOf(h, 'checkout.config/ui.banner_text')).map(
        (r) => r.status,
      ),
    ).toEqual(['superseded', 'supported']);
    const collections = await receiptsOf(h, 'checkout.config');
    expect(collections.map((r) => [r.source_revision, r.status])).toEqual([
      [collection.receipt.sourceRevision, 'supported'],
    ]);
    // Only the attempt that read the banner is affected.
    const affected = env.recovery.invalidations.flatMap(
      (e) => e.affected.attemptIds,
    );
    expect(affected).toEqual([reader.context.attemptId]);
    expect(await attemptStatus(env, bystander.context.attemptId)).toBe(
      'running',
    );
    expect(await attemptStatus(env, otherAttempt.context.attemptId)).toBe(
      'running',
    );
  });
});

it('membership changes: a deleted key retracts its member receipt and supersedes the collection receipt; re-inserting registers a new revision (C1)', async () => {
  await withWatcherEnv(async (env) => {
    const { h } = env;
    const m = await plannedMission(h, two);
    const collectionReader = await claimStart(h, { taskId: m.taskIds[0] });
    const memberReader = await claimStart(h, { taskId: m.taskIds[1] });
    const collection = await env.observeCollection(m.missionId);
    const banner = await env.observeMember(m.missionId, 'ui.banner_text');
    await env.link(collection.receipt.id, {
      attemptId: collectionReader.context.attemptId,
      taskId: m.taskIds[0],
      missionId: m.missionId,
    });
    await env.link(banner.receipt.id, {
      attemptId: memberReader.context.attemptId,
      taskId: m.taskIds[1],
      missionId: m.missionId,
    });
    const watcher = env.make();
    const base = collection.receipt.sourceRevision;

    const { rows } = await h.admin.query<{ version: string }>(
      "SELECT version FROM checkout.config_entries WHERE key = 'ui.banner_text'",
    );
    await advanceConfigUnconditionallyTx(env.injector, {
      key: 'ui.banner_text',
      deleteKey: true,
      causedBy: { actor: 'injector' },
    });
    expect(Number(rows[0].version)).toBe(1);
    expect(await watcher.pass()).toMatchObject({ registered: 1, retracted: 1 });

    expect(
      (await receiptsOf(h, 'checkout.config')).map((r) => [
        r.source_revision,
        r.status,
      ]),
    ).toEqual([
      [base, 'superseded'],
      [base + 1, 'supported'],
    ]);
    expect(
      (await receiptsOf(h, 'checkout.config/ui.banner_text')).map(
        (r) => r.status,
      ),
    ).toEqual(['retracted']);
    const reasons = env.recovery.invalidations.map((e) => e.reason).sort();
    expect(reasons).toEqual(['collection_changed', 'retraction']);
    const affected = env.recovery.invalidations.flatMap(
      (e) => e.affected.attemptIds,
    );
    expect(new Set(affected)).toEqual(
      new Set([
        collectionReader.context.attemptId,
        memberReader.context.attemptId,
      ]),
    );

    await advanceConfigUnconditionallyTx(env.injector, {
      key: 'ui.banner_text',
      value: 'back',
      insertIfMissing: true,
      causedBy: { actor: 'injector' },
    });
    // collection and the re-inserted member both register
    expect(await watcher.pass()).toMatchObject({ registered: 2 });
    expect((await receiptsOf(h, 'checkout.config')).at(-1)).toMatchObject({
      source_revision: base + 2,
      status: 'supported',
    });
  });
});
