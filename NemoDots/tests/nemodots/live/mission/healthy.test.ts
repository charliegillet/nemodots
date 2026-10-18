// Live: a mission from a goal only, on a dedicated stack instance, with the
// Crusoe model. EXPLORATORY SKELETON while the assertions are being settled.
import { appendFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createNemoDots, type NemoDots } from '../../../../src/server/nemodots/bootstrap.js';
import {
  requireLive,
  sleep,
  startLiveInstance,
  type LiveInstance,
} from './support.js';

let instance: LiveInstance;
let nemodots: NemoDots;
let pool: pg.Pool;
const log = (...a: unknown[]) => appendFileSync('/tmp/live-progress.log', a.join(' ') + '\n');

beforeAll(async () => {
  requireLive();
  instance = await startLiveInstance();
  nemodots = createNemoDots(instance.env, { workspace: { ownerId: 'live-owner' } });
  await nemodots.start();
  pool = new pg.Pool({ connectionString: instance.env.NEMODOTS_PG_URL_VERIFIER, max: 2 });
}, 180_000);

afterAll(async () => {
  await pool?.end().catch(() => undefined);
  await nemodots?.stop().catch(() => undefined);
  instance?.stop();
}, 60_000);

it('explore', async () => {
  const post = (path: string, body: unknown = {}) =>
    Promise.resolve(
      nemodots.router.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ).then((r) => r.json() as Promise<Record<string, any>>); // eslint-disable-line @typescript-eslint/no-explicit-any
  const health = await Promise.resolve(nemodots.router.request('/health')).then((r) => r.json());
  log('HEALTH', JSON.stringify({ mode: health.mode, pg: health.postgres, redis: health.redis, checkout: health.checkout, provider: health.provider.reachable, listed: health.provider.modelListed }));
  const mission = await post('/missions', { goal: 'Restore checkout availability while preserving customer data.' });
  log('CREATED', mission.id, mission.status);
  await post(`/missions/${mission.id}/start`);
  const deadline = Date.now() + 8 * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const snap = await Promise.resolve(nemodots.router.request(`/missions/${mission.id}`)).then((r) => r.json() as Promise<any>); // eslint-disable-line @typescript-eslint/no-explicit-any
    const line = `${snap.mission.status} tasks=${snap.tasks.length}[${snap.tasks.map((t: any) => t.role + ':' + t.status).join(',')}] attempts=${snap.attempts.length} findings=${snap.findings.length} actions=${snap.actions.length} calls=${snap.telemetry.calls}`; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (line !== last) log('STATE', line);
    last = line;
    if (['succeeded', 'failed', 'cancelled'].includes(snap.mission.status)) {
      log('FINAL', snap.mission.status, snap.mission.failureReason);
      break;
    }
    await sleep(2000);
  }
  expect(true).toBe(true);
}, 600_000);
