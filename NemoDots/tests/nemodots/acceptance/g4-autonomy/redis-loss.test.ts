// TEST_PROMPT gate 4 case 5 (Redis half): lose Redis during a mission. Work
// may be delayed, but authoritative state (PostgreSQL) must survive and the
// mission must finish exactly once after Redis returns. The user's Redis
// (6379) and the shared NemoDots Redis (56379) are never touched: this file
// starts and kills a private redis-server on 56385 under .local/acceptance/g4.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ofKind } from './analysis.js';
import { waitForMission } from './api.js';
import { G4 } from './config.js';
import { finish, launchMission, lazySystem } from './flow.js';
import {
  ALPHA,
  ALPHA_SOURCE,
  BRAVO,
  BRAVO_SOURCE,
  CHARLIE,
  compose,
  observeThenReport,
  planReply,
  TWO_BRANCH_PLAN,
} from './scenarios.js';
import { waitFor } from './system.js';

const PORT: number = G4.privateRedisPort;
if (PORT === 6379 || PORT === 56379) throw new Error('the Redis-loss test must use its own private port');

let redis: ChildProcess | null = null;
async function startRedis() {
  const dir = resolve(G4.scratch, 'redis-private');
  mkdirSync(dir, { recursive: true });
  redis = spawn(
    'redis-server',
    ['--port', String(PORT), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', dir],
    { stdio: 'ignore' },
  );
  const { createClient } = await import('redis');
  await waitFor('private redis PING', async () => {
    const c = createClient({ url: `redis://127.0.0.1:${PORT}/0` });
    c.on('error', () => undefined);
    try {
      await c.connect();
      return (await c.ping()) === 'PONG';
    } catch {
      return false;
    } finally {
      c.destroy();
    }
  }, 15_000);
}
async function killRedis() {
  if (!redis || redis.exitCode !== null) return;
  const gone = new Promise<void>((r) => redis!.once('exit', () => r()));
  redis.kill('SIGKILL');
  await gone;
}
afterAll(async () => {
  await killRedis();
});

const system = lazySystem({
  providerPort: G4.providerPort,
  script: compose(
    planReply(TWO_BRANCH_PLAN),
    observeThenReport(CHARLIE, 'checkout.health'),
    observeThenReport(BRAVO, BRAVO_SOURCE),
    observeThenReport(ALPHA, ALPHA_SOURCE),
  ),
  system: { redisUrl: `redis://127.0.0.1:${PORT}/0`, env: { NEMODOTS_LEASE_MS: '30000' } },
});

describe('G4.5d Redis loss: delayed work, authoritative state survives', () => {
  it('G4.5d Redis SIGKILL mid-mission, restart empty: state in PostgreSQL survives and the mission completes once', async () => {
    await startRedis();
    const { system: sys, provider: stub } = await system();
    const gate = stub.gate(
      (c) => c.kind === 'worker' && c.text.includes(ALPHA) && !c.text.includes(CHARLIE) && c.toolResults === 1,
    );
    const { mission, tail } = await launchMission(sys.api);
    try {
      await gate.arrived;
      const before = await sys.api.snapshot(mission.id);
      expect((await sys.api.health()).redis, 'Redis healthy before the loss').toBe('ok');

      await killRedis();
      await waitFor('health reports redis down', async () => (await sys.api.health()).redis === 'down', 45_000, 500);
      const during = await sys.api.snapshot(mission.id);
      expect(during.tasks.map((t) => t.id).sort(), 'authoritative tasks remain readable').toEqual(before.tasks.map((t) => t.id).sort());
      expect(['failed', 'cancelled'], 'Redis loss alone does not end the mission').not.toContain(during.mission.status);

      gate.release();
      await new Promise((r) => setTimeout(r, 5_000));
      const mid = await sys.api.snapshot(mission.id);
      expect(['failed', 'cancelled'], 'still alive after the delay').not.toContain(mid.mission.status);
      for (const task of before.tasks)
        expect(mid.tasks.find((t) => t.id === task.id), `task ${task.title} still present`).toBeDefined();

      await startRedis();
      await waitFor('health reports redis ok again', async () => (await sys.api.health()).redis === 'ok', 60_000, 500);
      const final = await waitForMission(
        sys.api,
        mission.id,
        (s) => s.tasks.filter((t) => [ALPHA, BRAVO].includes(t.title)).every((t) => t.status === 'succeeded'),
        120_000,
        'both branches succeed after Redis returns',
      );
      const alpha = final.tasks.find((t) => t.title === ALPHA)!;
      const bravo = final.tasks.find((t) => t.title === BRAVO)!;
      expect(final.attempts.filter((a) => a.taskId === alpha.id && a.status === 'published'), 'ALPHA published exactly once').toHaveLength(1);
      expect(final.attempts.filter((a) => a.taskId === bravo.id), 'BRAVO not re-run').toHaveLength(1);
      expect(final.outputs.filter((o) => o.taskId === alpha.id && o.usable), 'one usable ALPHA output').toHaveLength(1);
      expect(ofKind(tail.events, 'action.committed'), 'Redis loss created no controlled effect').toHaveLength(0);
      expect(tail.parseErrors).toEqual([]);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 420_000);
});
