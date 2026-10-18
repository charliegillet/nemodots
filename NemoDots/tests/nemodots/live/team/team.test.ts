// Live: the Nemotron team on Crusoe against a seeded fault. Nothing in the
// product scripts the plan, the tool arguments, the diagnosis or the answers;
// the assertions below check structure (a valid plan, observation, delegation,
// recorded identity), not what the model concluded. Results are written
// redacted to .local/<instance>/live/team.json (ids, counts, hosts, digests;
// never prompts or completions).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import {
  createRunbookStore,
  createTeamHandler,
  describeTeamPolicy,
} from '../../../../src/server/nemodots/team/index.js';
import {
  liveClient,
  requireLive,
  resultsDir,
  SUPER,
} from '../inference/support.js';
import { liveTeamConfig } from './config.js';
import { instrument, peakConcurrency, withLiveRig } from './harness.js';

const MAX_WAIT_MS = 8 * 60_000;
/** After the structural criteria hold, let the team keep working this long (depth, proposals). */
const SETTLE_MS = 4 * 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const summary: Record<string, unknown> = { suite: 'team-live', status: 'FAIL' };

afterAll(() => {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2)}\n`;
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key && key.length >= 6 && text.includes(key))
    throw new Error('secret found in live results; file not written');
  writeFileSync(join(dir, 'team.json'), text, { mode: 0o600 });
});

describe('Nemotron team on Crusoe', () => {
  it('plans, observes, and delegates recursively on a seeded fault', async () => {
    let env;
    try {
      env = requireLive();
    } catch (error) {
      summary.status = 'BLOCKED';
      summary.blocked = (error as Error).message;
      throw error;
    }
    const model = process.env.OPENAI_MODEL!.trim();
    const { adapter, stats } = instrument(liveClient(env, { maxInFlight: 4 }));
    const tools: {
      attemptId: string;
      name: string;
      ok: boolean;
      error?: string;
      detail?: string;
    }[] = [];
    const corrections: string[] = [];
    const usages: {
      role: string;
      spent: number;
      prompt: number;
      completion: number;
      cached: number | null;
    }[] = [];

    await withLiveRig(async (rig) => {
      const { sandbox, coordinator } = rig;
      // Break the cache through the same version authority the product uses.
      // The scenario warms the cache itself and verifies the symptom through
      // the readers before inject() resolves; nothing is primed by hand.
      const run = await sandbox.inject('cache_schema_mismatch', 1);
      expect((await run.ready).status).toBe('verified');
      await run.done;
      sandbox.reloadConfig();
      expect((await sandbox.request('/products')).status).toBe(500);

      const deps = {
        inference: adapter as never,
        coordinator: coordinator as never,
        observer: rig.observer,
        actions: {
          async propose(
            input: unknown,
            ctx: { modelCallId: string; toolCallId: string; taskId: string },
          ) {
            rig.proposals.push({
              input,
              modelCallId: ctx.modelCallId,
              toolCallId: ctx.toolCallId,
              taskId: ctx.taskId,
            });
            return {
              id: newUuid(),
              status: 'proposed',
              blockReason: null,
              blockDetail: null,
            } as never;
          },
        },
        reads: rig.reads,
        runbooks: createRunbookStore(),
        config: liveTeamConfig(model, env.host),
        onEvent: (event: {
          kind: string;
          attemptId?: string;
          name?: string;
          ok?: boolean;
          reason?: string;
          error?: string;
          detail?: string;
          spentTokens?: number;
          promptTokens?: number;
          completionTokens?: number;
          cachedTokens?: number | null;
          budgetTokens?: number;
          role?: string;
        }) => {
          if (event.kind === 'attempt_usage')
            usages.push({
              role: event.role!,
              spent: event.spentTokens!,
              prompt: event.promptTokens!,
              completion: event.completionTokens!,
              cached: event.cachedTokens ?? null,
            });
          if (event.kind === 'tool')
            tools.push({
              attemptId: event.attemptId!,
              name: event.name!,
              ok: event.ok!,
              error: event.error,
              detail: event.detail,
            });
          if (event.kind === 'correction') corrections.push(event.reason!);
        },
      };
      const host = coordinator.createWorkerHost({
        workerId: 'live-team',
        handler: createTeamHandler(deps),
        concurrency: 5,
        pollMs: 150,
        abortCheckMs: 250,
        onError: (error) => {
          corrections.push(`host_error:${(error as Error).name}`);
        },
      });

      const mission = await coordinator.control.create({
        goal: 'Restore checkout availability while preserving customer data.',
      });
      await coordinator.control.start(mission.id);
      host.start();

      const q = async (text: string, values: unknown[] = []) =>
        (await sandbox.pools.admin.query(text, values)).rows;
      let reached: Record<string, unknown> | null = null;
      let settleUntil = 0;
      const deadline = Date.now() + MAX_WAIT_MS;
      while (Date.now() < deadline) {
        const roots = await q(
          `SELECT id, role, status FROM coordinator.tasks
            WHERE mission_id = $1 AND parent_id IS NULL AND role <> 'planner'`,
          [mission.id],
        );
        const children = await q(
          `SELECT c.id, c.role, c.depth, c.parent_id, p.role AS parent_role, c.status
             FROM coordinator.tasks c JOIN coordinator.tasks p ON p.id = c.parent_id
            WHERE c.mission_id = $1 AND c.role LIKE '%_specialist'`,
          [mission.id],
        );
        // a specialist child whose attempt has observed something
        const observed = await q(
          `SELECT a.task_id, cardinality(a.read_set_receipt_ids) AS reads
             FROM coordinator.task_attempts a
            WHERE a.mission_id = $1 AND cardinality(a.read_set_receipt_ids) > 0`,
          [mission.id],
        );
        const observedTasks = new Set(observed.map((r) => r.task_id));
        const witnessed = children.find((c) => observedTasks.has(c.id));
        if (!reached && roots.length >= 2 && witnessed) {
          reached = {
            roots: roots.length,
            specialist: witnessed.role,
            depth: witnessed.depth,
            parentRole: witnessed.parent_role,
          };
          // keep going: let delegation recurse and proposals appear
          settleUntil = Math.min(deadline, Date.now() + SETTLE_MS);
        }
        if (settleUntil > 0 && Date.now() >= settleUntil) break;
        // nothing left to run and the criteria were not met: stop waiting
        const open = await q(
          `SELECT count(*)::int AS n FROM coordinator.tasks
            WHERE mission_id = $1 AND status NOT IN ('succeeded','failed','cancelled')`,
          [mission.id],
        );
        if (open[0].n === 0 && roots.length > 0) break;
        await sleep(2_000);
      }
      // let in-flight attempts settle briefly, then stop (aborts the rest)
      await sleep(3_000);
      await host.stop();

      const taskRows = await q(
        `SELECT id, role, depth, parent_id, status, justification FROM coordinator.tasks WHERE mission_id = $1`,
        [mission.id],
      );
      const failures = await q(
        `SELECT a.status, a.abort_reason, left(a.failure_reason, 240) AS failure_reason, t.role
           FROM coordinator.task_attempts a JOIN coordinator.tasks t ON t.id = a.task_id
          WHERE a.mission_id = $1 AND (a.failure_reason IS NOT NULL OR a.abort_reason IS NOT NULL)`,
        [mission.id],
      );
      // Diagnostic trace (final summaries and tool outcomes), written next to
      // the results file; contains model text about the checkout, no prompts.
      const outputs = await q(
        `SELECT t.role, t.depth, o.kind, CASE WHEN o.kind = 'plan' THEN o.content::text ELSE left(o.content->>'summary', 1500) END AS summary
           FROM coordinator.task_outputs o JOIN coordinator.tasks t ON t.id = o.task_id
          WHERE o.mission_id = $1 ORDER BY o.published_at`,
        [mission.id],
      ).catch(() => []);
      mkdirSync(resultsDir(), { recursive: true });
      writeFileSync(
        join(resultsDir(), 'team-trace.json'),
        `${JSON.stringify({ outputs, tools }, null, 2)}\n`,
        { mode: 0o600 },
      );
      // who proposed: the delegation path of every proposal
      const proposalPaths = await Promise.all(
        rig.proposals.map(async (proposal) => {
          const rows = await q(
            `SELECT t.role, t.depth, p.role AS parent_role
               FROM coordinator.tasks t LEFT JOIN coordinator.tasks p ON p.id = t.parent_id
              WHERE t.id = $1`,
            [proposal.taskId],
          );
          return {
            role: rows[0].role as string,
            depth: Number(rows[0].depth),
            parentRole: (rows[0].parent_role as string | null) ?? null,
          };
        }),
      );
      const maxDepth = Math.max(...taskRows.map((t) => Number(t.depth)));
      const delegated = taskRows.filter(
        (t) => t.parent_id !== null && t.justification,
      );
      const records = rig.modelCalls;

      Object.assign(summary, {
        reached,
        modelCalls: records.length,
        requests: stats.requests,
        maxInFlightHttp: peakConcurrency(records.flatMap((r) => r.attempts)),
        maxQueuedRequests: stats.maxInFlight,
        outcomes: stats.outcomes.reduce<Record<string, number>>(
          (acc, o) => ({ ...acc, [o]: (acc[o] ?? 0) + 1 }),
          {},
        ),
        hosts: [...stats.hosts],
        modelsReturned: [...stats.models],
        modelRequested: model,
        maxTaskDepth: maxDepth,
        tasks: taskRows.map((t) => ({
          role: t.role,
          depth: t.depth,
          status: t.status,
        })),
        delegatedTasks: delegated.length,
        verifierDelegations: delegated.filter((t) => t.role === 'verifier')
          .length,
        toolCalls: tools.reduce<Record<string, number>>(
          (acc, t) => ({ ...acc, [t.name]: (acc[t.name] ?? 0) + 1 }),
          {},
        ),
        refusals: tools
          .filter((t) => !t.ok)
          .map((t) => ({ name: t.name, error: t.error, detail: t.detail })),
        toolErrors: tools
          .filter((t) => !t.ok)
          .reduce<Record<string, number>>(
            (acc, t) => ({
              ...acc,
              [`${t.name}:${t.error}`]: (acc[`${t.name}:${t.error}`] ?? 0) + 1,
            }),
            {},
          ),
        corrections,
        attemptFailures: failures,
        policy: describeTeamPolicy(deps.config),
        depthNote:
          "delegation depth 2 (investigator > specialist > verifier) is induced by the pre-change verification policy (on by default); proposals themselves are the model's own choice",
        tokens: {
          basis:
            'input + output per attempt; cached reported separately (null = provider did not say)',
          attempts: usages.length,
          maxSpentByOneAttempt: Math.max(0, ...usages.map((u) => u.spent)),
          totalPrompt: usages.reduce((n, u) => n + u.prompt, 0),
          totalCompletion: usages.reduce((n, u) => n + u.completion, 0),
          totalCached: usages.some((u) => u.cached !== null)
            ? usages.reduce((n, u) => n + (u.cached ?? 0), 0)
            : null,
        },
        proposals: rig.proposals.length,
        proposalPaths: proposalPaths.map(
          (p) => `${p.parentRole ?? 'root'}>${p.role}@${p.depth}`,
        ),
        roles: records.reduce<Record<string, number>>(
          (acc, r) => ({ ...acc, [r.role]: (acc[r.role] ?? 0) + 1 }),
          {},
        ),
        recordDigest: digest(records.map((r) => r.id)),
      });

      // --- assertions: structure, not conclusions ---------------------------
      expect(
        reached,
        'planner plan + specialist observation within the wait',
      ).not.toBeNull();
      const planner = records.filter((r) => r.role === 'planner');
      expect(planner.length).toBeGreaterThanOrEqual(1);
      const roots = taskRows.filter(
        (t) => t.parent_id === null && t.role !== 'planner',
      );
      expect(roots.length).toBeGreaterThanOrEqual(2);

      // an investigator observed and delegated to a specialist who observed
      const investigatorIds = new Set(
        taskRows.filter((t) => t.role === 'investigator').map((t) => t.id),
      );
      expect(investigatorIds.size).toBeGreaterThan(0);
      expect(tools.some((t) => t.name === 'observe_source' && t.ok)).toBe(true);
      expect(tools.some((t) => t.name === 'delegate_task' && t.ok)).toBe(true);
      const specialistChild = taskRows.find(
        (t) =>
          String(t.role).endsWith('_specialist') &&
          investigatorIds.has(t.parent_id),
      );
      expect(
        specialistChild,
        'a specialist delegated by an investigator',
      ).toBeDefined();

      // every record: requested model returned, provider host is the configured one
      expect(records.length).toBeGreaterThanOrEqual(3);
      for (const record of records) {
        expect(record.model.requested).toBe(model);
        // a call cancelled by the host stopping has no returned model
        if (record.outcome !== 'aborted')
          expect(record.model.returned).toBe(model);
        expect(record.provider).toEqual({ host: env.host, mode: 'live' });
      }
      expect(
        peakConcurrency(records.flatMap((r) => r.attempts)),
      ).toBeLessThanOrEqual(4);
      expect(maxDepth).toBeGreaterThanOrEqual(1);
      // the D5 path, end to end: an investigator delegated a specialist that
      // proposed (through the action port)
      expect(
        proposalPaths.some(
          (p) =>
            p.parentRole === 'investigator' && p.role.endsWith('_specialist'),
        ),
        `proposal paths: ${JSON.stringify(proposalPaths)}`,
      ).toBe(true);
      summary.status = 'PASS';
    });
  });
});

function newUuid() {
  return crypto.randomUUID();
}
void SUPER;
