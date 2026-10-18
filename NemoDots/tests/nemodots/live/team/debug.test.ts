import { it } from 'vitest';
import { requireLive, liveClient } from '../inference/support.js';
import { sleep, withLiveWorld } from './world.js';

it('debug planner', async () => {
  const env = requireLive();
  const model = process.env.OPENAI_MODEL!.trim();
  await withLiveWorld(model, env.host, async (world) => {
    const missionId = await world.newMission('Restore the checkout service so a fresh order succeeds.');
    const host = world.coordinator.createWorkerHost({
      workerId: 'dbg', roles: ['planner'], concurrency: 1, pollMs: 200,
      handler: world.handlerFor(liveClient(env, { maxInFlight: 4 }) as never, { planner: model, worker: model }),
      onError: (e) => console.log('HOST ERROR', (e as Error).stack),
      onRun: (r) => console.log('RUN', JSON.stringify({ result: r.result, abort: r.abortReason, err: r.error ? String(r.error) : null })),
    });
    host.start();
    await sleep(60_000);
    await host.stop();
    const a = await world.admin.query('SELECT status, failure_reason, abort_reason FROM coordinator.task_attempts');
    console.log('ATTEMPTS', JSON.stringify(a.rows));
    const m = await world.admin.query('SELECT role, outcome, model_returned, model_requested FROM ledger.model_call_records');
    console.log('CALLS', JSON.stringify(m.rows));
    void missionId;
  });
}, 120_000);
