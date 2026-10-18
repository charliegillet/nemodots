// The delegation chain the incident policy induces (investigator -> cache
// specialist -> verifier) on the whole product with ONE worker slot. Before
// waiting parents released their slot, the verifier could not start until its
// parent's wait timed out (waitTimeoutMs, 180 s in incidentTeamConfig) and the
// parent then continued without the child's result.
//
// The model is the demo adversary's SCRIPTED ADAPTER POLICY (scripted-mission.ts;
// not a live trial); everything else is the product. That harness is read-only
// here and only imported.
import { describe, expect, it } from 'vitest';
import { withTestDatabase } from '../../helpers/test-db.js';
import { withTestRedis } from '../../helpers/test-redis.js';
import { scriptedEvidence } from '../../adversarial/demo/scripted-mission.js';

const ms = (value: unknown) => new Date(value as string).getTime();

describe('wait_for_children releases the worker slot', () => {
  it('a depth-3 delegation chain completes on ONE worker, children start promptly and parents see their results', async () => {
    const ev = await scriptedEvidence(withTestDatabase, withTestRedis, {
      rule: 'selective',
      scenarioClass: 'cache_schema_mismatch',
      minAgeMs: 0,
      latencyMs: 0,
      probeWindowMs: 1500,
      workers: 1,
      timeoutMs: 180_000,
    });
    const byId = new Map(ev.tasks.map((t) => [t.id as string, t]));
    const depthOf = (id: string): number => {
      const parent = byId.get(id)?.parent_id as string | null;
      return parent ? 1 + depthOf(parent) : 0;
    };
    // investigator (0) -> specialist (1) -> verifier (2): the chain needs 3 slots without parking
    expect(
      Math.max(0, ...ev.tasks.map((t) => depthOf(t.id as string))),
    ).toBeGreaterThanOrEqual(2);

    const firstStart = (taskId: string) =>
      Math.min(
        ...ev.attempts
          .filter((a) => a.task_id === taskId)
          .map((a) => ms(a.started_at)),
      );
    const slow = ev.tasks
      .filter((t) => t.parent_id !== null)
      .map((child) => ({
        child: `${child.title} (${child.role})`,
        waitedS: Math.round(
          (firstStart(child.id) - ms(child.created_at)) / 1000,
        ),
      }))
      .filter((c) => !(c.waitedS <= 20));
    expect(slow).toEqual([]);

    // a parent publishes only after every child it waited for has published
    const outputOf = (taskId: string) =>
      ev.outputs
        .filter((o) => o.task_id === taskId)
        .map((o) => ms(o.published_at));
    const early = ev.tasks
      .filter((t) => t.parent_id !== null)
      .flatMap((child) => {
        const parent = child.parent_id as string;
        const childDone = Math.min(...outputOf(child.id));
        const parentDone = Math.min(...outputOf(parent));
        return Number.isFinite(childDone) && parentDone < childDone
          ? [`${byId.get(parent)?.title} published before ${child.title}`]
          : [];
      });
    expect(early).toEqual([]);

    expect(ev.mission.status).toBe('succeeded');
  }, 240_000);
});
