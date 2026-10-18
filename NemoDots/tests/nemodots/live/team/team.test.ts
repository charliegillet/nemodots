import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { TeamInference } from '../../../../src/server/nemodots/team/index.js';
import {
  requireLive,
  liveClient,
  resultsDir,
  type LiveEnv,
} from '../inference/support.js';
import { sleep, until, withLiveWorld, type LiveWorld } from './world.js';

// Live Crusoe/Nemotron suite for the team (W4.1). Real inference, real
// coordinator, ledger, support validator and tools over a fresh test database.
// The only stub is the OBSERVED checkout symptoms (see world.ts). Missing
// credentials make every test fail with "BLOCKED: <name> missing".

const SPECIALISTS = [
  'cache_specialist',
  'database_specialist',
  'routing_specialist',
];
const NON_PLANNER = [
  'investigator',
  ...SPECIALISTS,
  'verifier',
  'postcondition',
] as never[];

const observed: Record<string, unknown> = {};
afterAll(() => {
  if (Object.keys(observed).length === 0) return;
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify({ suite: 'team-live', at: new Date().toISOString(), observed }, null, 2)}\n`;
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key && key.length >= 6 && text.includes(key))
    throw new Error('secret found in live results; file not written');
  writeFileSync(join(dir, 'team.json'), text, { mode: 0o600 });
});

function liveInference(env: LiveEnv): TeamInference {
  const client = liveClient(env, { maxInFlight: 4 });
  return client as unknown as TeamInference;
}

async function auditCalls(world: LiveWorld, missionId: string, env: LiveEnv) {
  const { rows } = await world.admin.query<{
    id: string;
    role: string;
    model_requested: string;
    model_returned: string | null;
    provider_host: string;
    provider_mode: string;
  }>(
    `SELECT id, role, model_requested, model_returned, provider_host, provider_mode
       FROM ledger.model_call_records WHERE mission_id = $1`,
    [missionId],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.model_returned, `call ${row.id}`).toBe(row.model_requested);
    expect(row.provider_host).toBe(env.host);
    expect(row.provider_mode).toBe('live');
  }
  return rows;
}

describe('team on Crusoe', () => {
  it('the planner produces a valid plan with at least two root tasks for the goal', async () => {
    const env = requireLive();
    const model = process.env.OPENAI_MODEL!.trim();
    await withLiveWorld(model, env.host, async (world) => {
      const missionId = await world.newMission(
        'Customers report problems at checkout. Restore the checkout service so that a fresh order succeeds, the inventory invariant holds and health stays ok.',
      );
      const host = world.coordinator.createWorkerHost({
        workerId: 'live-planner',
        roles: ['planner'],
        concurrency: 1,
        pollMs: 200,
        handler: world.handlerFor(liveInference(env), {
          planner: model,
          worker: model,
        }),
        onError: (error) =>
          console.error('host error', (error as Error).message),
      });
      host.start();
      try {
        const roots = await until(
          async () => {
            const { rows } = await world.admin.query<{
              role: string;
              title: string;
            }>(
              `SELECT role, title FROM coordinator.tasks
                WHERE mission_id = $1 AND parent_id IS NULL AND role <> 'planner'`,
              [missionId],
            );
            return rows.length >= 2 ? rows : null;
          },
          'a published plan',
          240_000,
        );
        expect(roots.length).toBeGreaterThanOrEqual(2);
        expect(roots.length).toBeLessThanOrEqual(6);
        const calls = await auditCalls(world, missionId, env);
        expect(calls.every((c) => c.role === 'planner')).toBe(true);
        expect(world.inFlight.max).toBeLessThanOrEqual(4);
        observed.planner = {
          rootTasks: roots.length,
          roles: roots.map((r) => r.role),
          modelCalls: calls.length,
          maxInFlight: world.inFlight.max,
        };
      } finally {
        await host.stop();
        await world.coordinator.control
          .cancel(missionId as never)
          .catch(() => undefined);
        await world.coordinator.outbox.stop();
      }
    });
  }, 600_000);

  it('on a seeded fault an investigator observes and delegates to a specialist whose attempt observes', async () => {
    const env = requireLive();
    const model = process.env.OPENAI_MODEL!.trim();
    await withLiveWorld(model, env.host, async (world) => {
      const missionId = await world.newMission(
        'Customers report problems at checkout. Restore the checkout service so that a fresh order succeeds, the inventory invariant holds and health stays ok.',
      );
      const investigatorId = await world.seedInvestigator(
        missionId,
        'Customers see intermittent 503 errors at checkout. Find the cause and get it repaired.',
      );
      const host = world.coordinator.createWorkerHost({
        workerId: 'live-workers',
        roles: NON_PLANNER,
        concurrency: 3,
        pollMs: 200,
        handler: world.handlerFor(liveInference(env), {
          planner: model,
          worker: model,
        }),
        onError: (error) =>
          console.error('host error', (error as Error).message),
      });
      host.start();
      try {
        const terminal = ['succeeded', 'failed', 'cancelled'];
        // the investigator delegates and the delegated specialist runs to completion
        await until(
          async () => {
            const { rows } = await world.admin.query<{
              id: string;
              status: string;
            }>(
              `SELECT id, status FROM coordinator.tasks WHERE mission_id = $1 AND parent_id = $2`,
              [missionId, investigatorId],
            );
            return rows.length > 0 &&
              rows.every((r) => terminal.includes(r.status))
              ? rows
              : null;
          },
          'delegated children to finish',
          420_000,
        );
        await sleep(500);
        const children = (
          await world.admin.query<{
            id: string;
            role: string;
            depth: number;
            status: string;
            justification: string | null;
          }>(
            `SELECT id, role, depth, status, justification FROM coordinator.tasks WHERE parent_id = $1`,
            [investigatorId],
          )
        ).rows;
        const specialists = children.filter((c) =>
          SPECIALISTS.includes(c.role),
        );
        expect(
          specialists.length,
          'a delegated specialist',
        ).toBeGreaterThanOrEqual(1);
        for (const child of children) {
          expect(child.depth).toBe(2);
          expect(child.justification).toBeTruthy();
        }

        const attemptOf = async (taskId: string) =>
          (
            await world.admin.query<{
              read_set_receipt_ids: string[];
              status: string;
            }>(
              `SELECT read_set_receipt_ids, status FROM coordinator.task_attempts WHERE task_id = $1 ORDER BY n`,
              [taskId],
            )
          ).rows;
        const parentAttempts = await attemptOf(investigatorId);
        expect(
          parentAttempts.some((a) => a.read_set_receipt_ids.length >= 1),
          'investigator observed',
        ).toBe(true);
        const childAttempts = (
          await Promise.all(specialists.map((s) => attemptOf(s.id)))
        ).flat();
        expect(
          childAttempts.some((a) => a.read_set_receipt_ids.length >= 1),
          'specialist observed',
        ).toBe(true);

        const toolEvents = await world.admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM coordinator.events WHERE mission_id = $1 AND kind = 'tool_call.recorded'`,
          [missionId],
        );
        expect(Number(toolEvents.rows[0].n)).toBeGreaterThanOrEqual(2);

        // the investigator cannot propose: no intent carries its attempt
        const intents = await world.admin.query<{ n: string }>(
          `SELECT count(*) AS n FROM coordinator.action_intents i
             JOIN coordinator.task_attempts a ON a.id = i.attempt_id WHERE a.task_id = $1`,
          [investigatorId],
        );
        expect(Number(intents.rows[0].n)).toBe(0);

        const calls = await auditCalls(world, missionId, env);
        expect(world.inFlight.max).toBeLessThanOrEqual(4);
        observed.delegation = {
          children: children.map((c) => ({
            role: c.role,
            depth: c.depth,
            status: c.status,
          })),
          modelCalls: calls.length,
          maxInFlight: world.inFlight.max,
          investigatorReadSet: parentAttempts.map(
            (a) => a.read_set_receipt_ids.length,
          ),
          specialistReadSet: childAttempts.map(
            (a) => a.read_set_receipt_ids.length,
          ),
        };
      } finally {
        await host.stop();
        await world.coordinator.control
          .cancel(missionId as never)
          .catch(() => undefined);
        await world.coordinator.outbox.stop();
      }
    });
  }, 720_000);
});
