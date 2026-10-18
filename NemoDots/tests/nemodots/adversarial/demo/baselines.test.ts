// W6.3 demo adversary: are the baselines fair? The same SCRIPTED ADAPTER
// POLICY mission (scripted-mission.ts; not a live trial) runs under the three
// production recovery scope rules (evals/strategies, registered exactly as the
// evaluation driver registers them). BUILD_PROMPT: identical tools, policies,
// checks, model and budget; only the recovery scope may differ. Checked from
// raw rows and the captured model requests:
//   - the rule recorded on the mission is the arm;
//   - the same admission checks: the stale proposal is decided identically;
//   - the same repair context: every repair/replan attempt starts from fresh
//     reads and the invalidation summary, never the old transcript;
//   - the scopes differ only as declared (broad restarts the independent
//     branch; selective and dag-restart do not here; dag-restart never restarts
//     less than the evidence closure).
import { beforeAll, describe, expect, it } from 'vitest';
import { withTestDatabase } from '../../helpers/test-db.js';
import { withTestRedis } from '../../helpers/test-redis.js';
import { scriptedEvidence, type Evidence } from './scripted-mission.js';
import type { Json } from './support.js';

const RULES = ['selective', 'dag-restart', 'broad-restart'] as const;
const arms = new Map<string, Evidence>();

beforeAll(async () => {
  const results = await Promise.all(
    RULES.map((rule) =>
      scriptedEvidence(withTestDatabase, withTestRedis, {
        rule,
        minAgeMs: 3000,
        latencyMs: 300,
        probeWindowMs: 4000,
        workers: 6,
        timeoutMs: 150_000,
      }),
    ),
  );
  RULES.forEach((rule, i) => arms.set(rule, results[i]));
}, 300_000);

const ms = (value: unknown) => new Date(value as string).getTime();
const KEY = 'checkout.config/cache.schema_version';
const REPAIR_NOTICE = 'This attempt repairs earlier work';

describe('baseline arms run under the same checks and context (D8)', () => {
  it('each mission records the rule of its arm', () => {
    for (const rule of RULES)
      expect(arms.get(rule)!.mission.recovery_scope_rule).toBe(rule);
  });

  it('the stale proposal is decided identically in every arm (same admission checks)', () => {
    const decisions = RULES.map((rule) => {
      const ev = arms.get(rule)!;
      const depAt = ms(ev.faultSteps[1]?.applied_at);
      const first = ev.intents.find(
        (i) => i.payload?.key === 'cache.schema_version',
      );
      return {
        rule,
        fired: ev.faultSteps[1]?.status,
        proposedBeforeChange: first ? ms(first.proposed_at) <= depAt : null,
        status: first?.status,
        reason: first?.block_reason,
        stages: ev.authorizations
          .filter((a) => a.action_id === first?.id)
          .map((a) => `${a.stage}:${a.decision}:${a.block_reason ?? ''}`),
      };
    });
    for (const d of decisions)
      expect({ ...d, rule: 'any' }).toEqual({
        ...decisions[0],
        rule: 'any',
      });
    expect(decisions[0]).toMatchObject({
      fired: 'applied',
      proposedBeforeChange: true,
      status: 'blocked',
      reason: 'stale_version',
    });
  });

  it('every repair and replan attempt in every arm starts from fresh reads and the invalidation summary, never the old transcript', () => {
    const problems: string[] = [];
    const layouts = new Set<string>();
    for (const rule of RULES) {
      const ev = arms.get(rule)!;
      const repairs = ev.firstSnapshots.filter(
        (s) => s.kind === 'repair' || s.kind === 'replan',
      );
      expect(repairs.length, rule).toBeGreaterThan(0);
      for (const snap of repairs) {
        layouts.add(snap.layout);
        const title = ev.tasks.find((t) => t.id === snap.task_id)?.title;
        if ((snap.injected.historyItems as Json[]).length > 0)
          problems.push(
            `${rule} ${title}: ${snap.injected.historyItems.length} transcript items on the first call`,
          );
        if (
          !(snap.injected.invalidationEvents as string[]).includes(
            snap.repair_of?.invalidationEventId,
          )
        )
          problems.push(
            `${rule} ${title}: the invalidation summary is missing`,
          );
      }
      // the same text the model reads: the repair notice and the summary line
      const opening = ev.calls.filter(
        (c) => c.repair && c.history.length === 1 && c.format === null,
      );
      expect(opening.length, rule).toBeGreaterThan(0);
      for (const call of opening) {
        const system: string = JSON.parse(call.raw).messages[0].content;
        if (!system.includes(REPAIR_NOTICE))
          problems.push(`${rule} ${call.title}: no repair notice`);
        if (!/## Invalidations[\s\S]*Source [^\n]+ changed/.test(system))
          problems.push(`${rule} ${call.title}: no invalidation summary text`);
      }
    }
    expect(problems).toEqual([]);
    expect([...layouts]).toEqual(['cache_aware']);
  });

  it('the scopes differ only as declared: broad restarts the independent branch, selective and dag-restart leave it', () => {
    const routingRepairs = RULES.map((rule) => {
      const ev = arms.get(rule)!;
      const routing = ev.tasks.find((t) => t.title === 'Routing branch')!;
      return ev.attempts.filter(
        (a) => a.task_id === routing.id && a.kind !== 'initial',
      ).length;
    });
    expect(routingRepairs[0]).toBe(0);
    expect(routingRepairs[1]).toBe(0);
    expect(routingRepairs[2]).toBeGreaterThan(0);
  });

  it('dag-restart never restarts less than the evidence closure of the changed receipt', () => {
    const ev = arms.get('dag-restart')!;
    const event = ev.invalidationEvents.find((e) => e.source_key === KEY)!;
    const entry = (event.per_mission as Json[])[0];
    const restarted = new Set(
      ev.recoveries
        .filter(
          (r) =>
            r.invalidation_event_id === event.id &&
            [
              'repair_scheduled',
              'repair_coalesced',
              'replan_scheduled',
            ].includes(r.kind),
        )
        .map((r) => r.task_id),
    );
    expect(
      (entry.affected.taskIds as string[]).filter((t) => !restarted.has(t)),
    ).toEqual([]);
  });
});
