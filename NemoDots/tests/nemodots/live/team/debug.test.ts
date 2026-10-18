import { it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { requireLive, liveClient } from '../inference/support.js';
import { sleep, withLiveWorld } from './world.js';
const log = (...a: unknown[]) =>
  appendFileSync('/tmp/w4dbg.log', a.join(' ') + '\n');

it('debug investigator', async () => {
  const env = requireLive();
  const model = process.env.OPENAI_MODEL!.trim();
  await withLiveWorld(model, env.host, async (world) => {
    const missionId = await world.newMission(
      'Restore the checkout service so a fresh order succeeds.',
    );
    await world.seedInvestigator(
      missionId,
      'Establish whether the checkout service is healthy. If something is wrong, establish what, and make sure the necessary repair is carried out by someone able to do it.',
    );
    const host = world.coordinator.createWorkerHost({
      workerId: 'dbg',
      roles: [
        'investigator',
        'cache_specialist',
        'database_specialist',
        'routing_specialist',
        'verifier',
      ] as never[],
      concurrency: 3,
      pollMs: 200,
      handler: world.handlerFor(liveClient(env, { maxInFlight: 4 }) as never, {
        planner: model,
        worker: model,
      }),
      onError: (e) => log('HOST ERROR', (e as Error).stack),
      onRun: (r) =>
        log(
          'RUN',
          JSON.stringify({
            t: r.taskId.slice(0, 8),
            result: r.result,
            abort: r.abortReason,
            err: r.error ? String(r.error).slice(0, 300) : null,
          }),
        ),
    });
    host.start();
    await sleep(150_000);
    await host.stop();
    const t = await world.admin.query(
      'SELECT left(id::text,8) id, role, status, depth FROM coordinator.tasks',
    );
    log('TASKS', JSON.stringify(t.rows));
    const a = await world.admin.query(
      'SELECT left(task_id::text,8) task, status, left(failure_reason,200) f, abort_reason, cardinality(read_set_receipt_ids) rs, cardinality(model_call_ids) mc FROM coordinator.task_attempts',
    );
    log('ATTEMPTS', JSON.stringify(a.rows));
    const m = await world.admin.query(
      'SELECT role, outcome, tool_calls FROM ledger.model_call_records ORDER BY created_at',
    );
    log(
      'CALLS',
      JSON.stringify(
        m.rows.map((r) => [
          r.role,
          r.outcome,
          (r.tool_calls as { name: string }[]).map((c) => c.name),
        ]),
      ),
    );
  });
}, 300_000);
