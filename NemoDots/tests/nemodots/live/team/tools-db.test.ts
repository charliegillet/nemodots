import { describe, expect, it } from 'vitest';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import type { AttemptContext } from '../../../../src/server/nemodots/contracts/index.js';
import { createPgTeamReader } from '../../../../src/server/nemodots/team/index.js';
import { withLiveWorld, type LiveWorld } from './world.js';

// The team tools over the REAL coordinator, ledger and PostgreSQL (a fresh
// test database). No model is involved, so this file needs no credentials. It
// lives under live/ because it needs the NemoDots stack (npm run
// test:nemodots:live). Observed checkout sources are the labelled simulation of
// world.ts; configuration sources are read from the real authority tables.

async function claim(world: LiveWorld): Promise<AttemptContext> {
  const missionId = await world.newMission('tools-db goal');
  await world.seedInvestigator(missionId, 'tools-db question');
  const claimed = await world.coordinator.claimAttempt({
    workerId: 'tools-db',
    missionId: missionId as never,
    roles: ['investigator'],
  });
  if (!claimed) throw new Error('nothing to claim');
  await world.coordinator.startAttempt(claimed.context);
  return claimed.context;
}

async function counts(world: LiveWorld, context: AttemptContext) {
  const one = async (sql: string, values: unknown[]) =>
    Number((await world.admin.query<{ n: string }>(sql, values)).rows[0].n);
  return {
    receipts: await one(
      'SELECT count(*) AS n FROM ledger.observation_receipts',
      [],
    ),
    confirmations: await one(
      'SELECT count(*) AS n FROM ledger.receipt_confirmations',
      [],
    ),
    edges: await one(
      'SELECT count(*) AS n FROM ledger.dependency_edges WHERE mission_id = $1',
      [context.missionId],
    ),
    toolEvents: await one(
      `SELECT count(*) AS n FROM coordinator.events WHERE mission_id = $1 AND kind = 'tool_call.recorded'`,
      [context.missionId],
    ),
    readSet: await one(
      'SELECT cardinality(read_set_receipt_ids) AS n FROM coordinator.task_attempts WHERE id = $1',
      [context.attemptId],
    ),
    tasks: await one(
      'SELECT count(*) AS n FROM coordinator.tasks WHERE mission_id = $1',
      [context.missionId],
    ),
    findings: await one(
      'SELECT count(*) AS n FROM coordinator.findings WHERE mission_id = $1',
      [context.missionId],
    ),
  };
}

describe('team reader over PostgreSQL', () => {
  it('every read the worker loop makes runs against the real schema', async () => {
    await withLiveWorld('model', 'host.invalid', async (world) => {
      const context = await claim(world);
      const reader = createPgTeamReader(world.app);
      const mission = await reader.mission(context.missionId);
      expect(mission.budgets.maxDepth).toBe(3);
      expect(
        await reader.prerequisiteOutputs(context.missionId, context.taskId),
      ).toEqual([]);
      expect(await reader.taskOutputs(context.missionId, [])).toEqual([]);
      expect(await reader.receipts([])).toEqual([]);
      expect(await reader.snapshotVector('not-a-uuid', context)).toBeNull();
      expect(
        await reader.readSetOf(context.attemptId, context.missionId),
      ).toEqual([]);
      expect(
        (await reader.planOverview(context.missionId)).length,
      ).toBeGreaterThanOrEqual(2);
      expect(await reader.missionUsage(context.missionId)).toEqual({
        calls: 0,
        tokens: 0,
      });
      const facts = await reader.delegationFacts(context);
      expect(facts.parent.role).toBe('investigator');
      expect(facts.limits.maxTasks).toBe(24);
    });
  }, 60_000);
});

describe('team tools over PostgreSQL', () => {
  it('observe_source: one receipt, one evidence edge, one readset entry, one event; a repeat confirms; unreadable sources write nothing', async () => {
    await withLiveWorld('model', 'host.invalid', async (world) => {
      const context = await claim(world);
      const call = (sourceKey: string, id: string) =>
        world.tools.execute(
          'observe_source',
          { sourceKey },
          { context, toolCallId: id },
        );
      const start = await counts(world, context);

      const first = (await call('checkout.config/db.pool_max', 'tc-1')) as {
        receiptId: string;
        valueDigest: string;
        revision: number;
      };
      expect(first.valueDigest).toBe(digest(1));
      const afterFirst = await counts(world, context);
      expect(afterFirst.receipts - start.receipts).toBe(1);
      expect(afterFirst.edges - start.edges).toBe(1);
      expect(afterFirst.toolEvents - start.toolEvents).toBe(1);
      expect(afterFirst.readSet - start.readSet).toBe(1);

      await call('checkout.config/db.pool_max', 'tc-2');
      const afterSecond = await counts(world, context);
      expect(afterSecond.receipts).toBe(afterFirst.receipts);
      expect(afterSecond.confirmations - afterFirst.confirmations).toBe(1);
      expect(afterSecond.readSet).toBe(afterFirst.readSet);

      await expect(call('redis.stats', 'tc-3')).rejects.toMatchObject({
        code: 'source_unavailable',
      });
      await expect(call('checkout.secrets', 'tc-4')).rejects.toMatchObject({
        code: 'invalid_arguments',
      });
      const unchanged = await counts(world, context);
      expect(unchanged.receipts).toBe(afterSecond.receipts);
      expect(unchanged.edges).toBe(afterSecond.edges);

      // an absent key yields negative evidence on the membership collection
      const absent = (await call('checkout.config/no.such.key', 'tc-5')) as {
        sourceKey: string;
        negative: { predicate: string };
      };
      expect(absent.sourceKey).toBe('checkout.config');
      expect(absent.negative.predicate).toContain('no.such.key');
    });
  }, 120_000);

  it('publish_finding and delegate_task are fenced, scope-checked and bounded by the real coordinator', async () => {
    await withLiveWorld('model', 'host.invalid', async (world) => {
      const context = await claim(world);
      const other = await claim(world);
      const run = (
        name: string,
        args: unknown,
        ctx = context,
        id = `t-${name}`,
      ) => world.tools.execute(name, args, { context: ctx, toolCallId: id });

      const mine = (await run('observe_source', {
        sourceKey: 'checkout.health',
      })) as { receiptId: string };
      const foreign = (await run(
        'observe_source',
        { sourceKey: 'checkout.metrics' },
        other,
        'o-1',
      )) as {
        receiptId: string;
      };
      const before = await counts(world, context);

      // a receipt of another mission is outside this attempt's scope
      await expect(
        run('publish_finding', {
          claim: 'x',
          supportingReceiptIds: [foreign.receiptId],
          confidence: 'low',
        }),
      ).rejects.toMatchObject({ code: 'citation_out_of_scope' });
      expect((await counts(world, context)).findings).toBe(before.findings);

      await run('publish_finding', {
        claim: 'Health is degraded.',
        supportingReceiptIds: [mine.receiptId],
        confidence: 'medium',
      });
      expect((await counts(world, context)).findings).toBe(before.findings + 1);

      // an investigator cannot propose; nothing is stored
      await expect(
        run('propose_action', {
          action: 'set_config',
          payload: {
            key: 'db.pool_max',
            value: 8,
            expectedCurrentValueDigest: digest(1),
          },
          supportingReceiptIds: [],
          rationale: 'raise it',
        }),
      ).rejects.toMatchObject({ code: 'capability_denied' });
      const intents = await world.admin.query<{ n: string }>(
        'SELECT count(*) AS n FROM coordinator.action_intents',
      );
      expect(Number(intents.rows[0].n)).toBe(0);

      const delegation = (n: number) => ({
        title: `child ${n}`,
        role: 'verifier',
        question: 'Check something.',
        dependsOn: [],
        justification: 'Independent check.',
      });
      // a stale fencing token is refused with no write
      const stale = { ...context, fencingToken: context.fencingToken + 1 };
      const tasksBefore = (await counts(world, context)).tasks;
      await expect(
        run('delegate_task', delegation(0), stale, 'd-0'),
      ).rejects.toThrow(/fence|token|stale/i);
      expect((await counts(world, context)).tasks).toBe(tasksBefore);

      // delegation: bounded by breadth 4 under the mission lock
      for (let n = 1; n <= 4; n += 1)
        await run('delegate_task', delegation(n), context, `d-${n}`);
      await expect(
        run('delegate_task', delegation(5), context, 'd-5'),
      ).rejects.toMatchObject({ code: 'delegation_rejected' });
      const children = await world.admin.query<{
        depth: number;
        capabilities: string[];
      }>(
        'SELECT depth, capabilities FROM coordinator.tasks WHERE parent_id = $1',
        [context.taskId],
      );
      expect(children.rows).toHaveLength(4);
      expect(children.rows.every((r) => r.depth === 2)).toBe(true);
      expect([...children.rows[0].capabilities].sort()).toEqual([
        'observe',
        'publish_finding',
      ]);
    });
  }, 180_000);
});
