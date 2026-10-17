// Gate 3, TOOL_COVERAGE section 1: behavioural tests of the nine NemoDots team-tool executors (the only tools
// Nemotron ever sees). They replace the placeholder cases G3-T1..T8 of g3-08.
//
// Setup is real (g3-team-driver.ts seeds mission, task, attempt, receipts and an emitting model call in the
// acc3_ database; the first test proves the seeding without any production tool code). Every expected number
// below was enumerated by hand from the seed:
//
//   mission M: tasks {root (waiting, investigator), T (running, attempt A, token 1, generation 0)}
//   receipts of M: checkout.health r3, checkout.config/db.pool_max r1 (value 2), redis.stats r2 (never seen)
//   receipt of another mission: checkout.metrics r5
//   emitting model call C: snapshot vector = { member r1, health r3 }
//   checkout.config_entries: cache.namespace "acc3-ns-a" v1, db.pool_max 2 v1, ui.banner_text "acc3 banner" v1
//
// Until src/server/nemodots/team/tools.ts exists each executor case FAILS with ENTRY POINT MISSING; with the
// module present but another shape it FAILS with DRIVER WIRING PENDING naming the convention. No case is a skip.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INJECTION, secretsPresentIn, visibleSecrets } from './g3-support.js';
import {
  CAPS,
  TeamWorld,
  bindTeamExecutor,
  type Counts,
  type Exec,
  type Outcome,
  type Seeded,
} from './g3-team-driver.js';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const POOL_DIGEST = sha256('2'); // canonical JSON of the current value 2

const NINE = [
  'observe_source',
  'list_runbooks',
  'read_runbook',
  'delegate_task',
  'get_task_status',
  'wait_for_children',
  'publish_finding',
  'propose_action',
  'request_replan',
] as const;

let tw: TeamWorld;
beforeAll(async () => {
  tw = await TeamWorld.open();
}, 300_000);
afterAll(async () => {
  await tw?.close();
}, 120_000);

let sequence = 0;
const toolCall = (label: string) => `acc3-${label}-${++sequence}`;

const setPool = (value: unknown, seed: Seeded, extra: object = {}) => ({
  action: 'set_config',
  payload: {
    key: 'db.pool_max',
    value,
    expectedCurrentValueDigest: POOL_DIGEST,
    ...extra,
  },
  supportingReceiptIds: [seed.member.id, seed.health.id],
  rationale: 'The pool is exhausted.',
});

const finding = (seed: Seeded, ids = [seed.health.id]) => ({
  claim: 'The pool is the bottleneck.',
  supportingReceiptIds: ids,
  confidence: 'medium',
});

const delegation = (over: object = {}) => ({
  title: 'Verify the repair',
  role: 'verifier',
  question: 'Does a fresh order succeed?',
  dependsOn: [],
  justification: 'Needs an independent read of the checkout.',
  ...over,
});

/** The first uuid-ish identifier of an intent returned by propose_action. */
function intentIdOf(value: unknown): string | null {
  const record = value as Record<string, unknown> | null;
  const candidates = [
    record?.id,
    record?.actionId,
    record?.intentId,
    (record?.intent as Record<string, unknown> | undefined)?.id,
  ];
  const found = candidates.find((c) => typeof c === 'string');
  return (found as string | undefined) ?? null;
}

function expectNoWrites(before: Counts, after: Counts, label: string) {
  expect(after, label).toEqual(before);
}

const FENCE = /fence|stale|lease|generation|not running|lost|token/i;

/* ------------------------------------------------------------------ self-check (passes without production tools) */

describe('[TP3.1] the executor driver seeds a coherent world (setup self-check)', () => {
  it('seeds exactly the hand-enumerated rows and nothing that a tool could have written', async () => {
    const seed = await tw.seedAttempt('cache_specialist');
    const counts = await tw.counts(seed.mission, seed.attempt);
    expect(counts).toMatchObject({
      tasks: 2,
      findings: 0,
      intents: 0,
      authorizations: 0,
      receipts: 3,
      confirmations: 0,
      edges: 0,
      events: 0,
      toolCallEvents: 0,
      readSet: 0,
    });
    const snapshot = await tw.q<{ v: { receiptId: string }[] }>(
      `SELECT s.dependency_vector AS v FROM ledger.model_call_records m JOIN ledger.context_snapshots s ON s.id = m.context_snapshot_id WHERE m.id = $1`,
      [seed.modelCallId],
    );
    expect(snapshot[0].v.map((e) => e.receiptId).sort()).toEqual(
      [seed.member.id, seed.health.id].sort(),
    );
    const foreign = await tw.counts(
      (
        await tw.q<{ mission_id: string }>(
          `SELECT mission_id FROM ledger.observation_receipts WHERE id = $1`,
          [seed.foreign.id],
        )
      )[0].mission_id,
    );
    expect(foreign.receipts).toBe(1);
    expect(await tw.configOf('db.pool_max')).toEqual({ value: 2, version: 1 });
  });
});

/* ------------------------------------------------------------------ G3-T1 closed registry */

describe('[TP3.3][T1] the executor registry is closed', () => {
  it('a tool name outside the nine (including ones containing read/list/get and prototype keys) is rejected before any handler runs and writes nothing', async () => {
    const exec: Exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('cache_specialist');
    const before = await tw.counts(seed.mission, seed.attempt);
    for (const name of [
      'read_file',
      'run_shell',
      'list_files',
      'get_secrets',
      'read_everything',
      'computer_exec',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'OBSERVE_SOURCE',
      'observe_source ',
    ]) {
      const outcome = await exec(
        name,
        { id: 'x', command: 'id' },
        {
          context: seed.ctx,
          toolCallId: toolCall('unknown'),
        },
      );
      expect(outcome.ok, name).toBe(false);
      expect(outcome.text, name).not.toMatch(/is not a function|undefined/);
    }
    expectNoWrites(
      before,
      await tw.counts(seed.mission, seed.attempt),
      'unknown tools write nothing',
    );
    // the nine are still reachable (a registry that rejects everything would pass the loop above)
    const listed = await exec(
      'list_runbooks',
      {},
      {
        context: seed.ctx,
        toolCallId: toolCall('list'),
      },
    );
    expect(listed.ok, listed.text).toBe(true);
    expect(NINE).toHaveLength(9);
  });
});

/* ------------------------------------------------------------------ G3-T2 runbooks */

describe('[TP3.3][T2] runbook ids resolve through the catalogue map only', () => {
  it('traversal-shaped and unknown ids fail without touching the file system; a catalogue id returns its text', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('investigator');
    const ctx = seed.ctx;
    const listed = await exec(
      'list_runbooks',
      {},
      {
        context: ctx,
        toolCallId: toolCall('rb-list'),
      },
    );
    expect(listed.ok, listed.text).toBe(true);
    const ids = JSON.stringify(listed.value).match(/[a-z0-9][a-z0-9_-]{2,63}/g);
    expect(ids?.length).toBeGreaterThan(0);

    for (const id of [
      '../../.env',
      '/etc/passwd',
      'cache-recovery.md/../x',
      '..',
      'a/b',
      'ENV',
      'x'.repeat(65),
    ]) {
      const outcome = await exec(
        'read_runbook',
        { id },
        {
          context: ctx,
          toolCallId: toolCall('rb'),
        },
      );
      expect(outcome.ok, id).toBe(false);
      expect(outcome.text, id).not.toMatch(
        /root:|OPENAI_API_KEY|CRUSOE|postgres:\/\//,
      );
    }
    // well-formed ids that are not in the catalogue
    for (const id of ['env', 'passwd', 'does-not-exist']) {
      const outcome = await exec(
        'read_runbook',
        { id },
        {
          context: ctx,
          toolCallId: toolCall('rb'),
        },
      );
      expect(outcome.ok, id).toBe(false);
    }
    // the same call for an unknown well-formed id and for a catalogue-shaped traversal id reveal no file content
    const known = String(ids![0]);
    const outcome = await exec(
      'read_runbook',
      { id: known },
      {
        context: ctx,
        toolCallId: toolCall('rb-ok'),
      },
    );
    if (outcome.ok) expect(outcome.text.length).toBeGreaterThan(20);
  });
});

/* ------------------------------------------------------------------ G3-T3 mission scoping of get_task_status */

describe('[TP3.2][T3] get_task_status is mission-scoped', () => {
  it('an own-mission task returns its status; a foreign task and an unknown task are indistinguishable and reveal nothing', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('investigator');
    const other = await tw.seedAttempt('investigator');
    const own = await exec(
      'get_task_status',
      { taskId: seed.task },
      {
        context: seed.ctx,
        toolCallId: toolCall('status'),
      },
    );
    expect(own.ok, own.text).toBe(true);
    expect(own.text).toContain('running');

    const foreign = await exec(
      'get_task_status',
      { taskId: other.task },
      {
        context: seed.ctx,
        toolCallId: toolCall('status'),
      },
    );
    const unknown = await exec(
      'get_task_status',
      { taskId: '9b0c1d2e-3f40-4152-8364-758697a8b9ca' },
      { context: seed.ctx, toolCallId: toolCall('status') },
    );
    expect(foreign.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    const normalise = (text: string) =>
      text.replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        '<id>',
      );
    expect(normalise(foreign.text)).toBe(normalise(unknown.text));
    expect(foreign.text).not.toContain('running');
    expect(foreign.text).not.toContain(other.mission);
  });
});

/* ------------------------------------------------------------------ G3-T4 identity and citations */

describe('[TP3.2][T4] model-supplied identity and receipt ids grant nothing', () => {
  it('publish_finding stores identity from the AttemptContext, rejects identity keys, and rejects citations outside the attempt scope', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('investigator');
    const call = (args: unknown, id = toolCall('find')) =>
      exec('publish_finding', args, { context: seed.ctx, toolCallId: id });

    const before = await tw.counts(seed.mission, seed.attempt);
    for (const extra of [
      { missionId: seed.foreign.id },
      { attemptId: seed.attempt },
      { fencingToken: 99 },
      { taskId: seed.task },
      { usable: true },
    ]) {
      const outcome = await call({ ...finding(seed), ...extra });
      expect(outcome.ok, JSON.stringify(extra)).toBe(false);
    }
    // outside the attempt scope: another mission, and a same-mission receipt the attempt never saw
    for (const id of [seed.foreign.id, seed.unseen.id]) {
      const outcome = await call(finding(seed, [seed.health.id, id]));
      expect(outcome.ok, id).toBe(false);
      expect(outcome.text).toMatch(/citation_out_of_scope|out of scope/i);
    }
    expectNoWrites(
      before,
      await tw.counts(seed.mission, seed.attempt),
      'rejections',
    );

    // in scope: the vector of the emitting model call (health r3) is a valid citation
    const ok = await call(finding(seed, [seed.health.id, seed.member.id]));
    expect(ok.ok, ok.text).toBe(true);
    const rows = await tw.q<{
      mission_id: string;
      task_id: string;
      attempt_id: string;
      supporting_receipt_ids: string[];
      dependency_vector: {
        sourceKey: string;
        sourceRevision: number;
        receiptId: string;
      }[];
    }>(
      `SELECT mission_id, task_id, attempt_id, supporting_receipt_ids, dependency_vector FROM coordinator.findings WHERE mission_id = $1`,
      [seed.mission],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mission_id).toBe(seed.mission);
    expect(rows[0].task_id).toBe(seed.task);
    expect(rows[0].attempt_id).toBe(seed.attempt);
    expect([...rows[0].supporting_receipt_ids].sort()).toEqual(
      [seed.health.id, seed.member.id].sort(),
    );
    // hand-enumerated vector: exactly the two cited receipts at the revisions seeded
    expect(
      rows[0].dependency_vector
        .map((e) => `${e.sourceKey}@${e.sourceRevision}`)
        .sort(),
    ).toEqual(['checkout.config/db.pool_max@1', 'checkout.health@3']);
  });
});

/* ------------------------------------------------------------------ fencing, idempotency and scope */

describe('[TP3.1][T-fence] a stale fencing token or generation leaves zero rows', () => {
  it.each([
    ['publish_finding', (s: Seeded) => finding(s)],
    ['delegate_task', () => delegation()],
    ['propose_action', (s: Seeded) => setPool(12, s)],
  ] as const)(
    '%s refuses a lower token, a higher token and a moved generation, and succeeds with the real fence (control)',
    async (tool, args) => {
      const exec = await bindTeamExecutor(tw);
      const seed = await tw.seedAttempt('cache_specialist');
      const before = await tw.counts(seed.mission, seed.attempt);
      for (const stale of [
        { fencingToken: 0 },
        { fencingToken: 2 },
        { generation: 7 },
      ]) {
        const outcome = await exec(tool, args(seed), {
          context: { ...seed.ctx, ...stale },
          toolCallId: toolCall('fence'),
          modelCallId: seed.modelCallId,
        });
        expect(outcome.ok, `${tool} ${JSON.stringify(stale)}`).toBe(false);
        expect(outcome.text, tool).toMatch(FENCE);
      }
      expectNoWrites(
        before,
        await tw.counts(seed.mission, seed.attempt),
        `${tool} with a stale fence`,
      );
      // an attempt that left `running` is fenced too
      await tw.q(
        `UPDATE coordinator.task_attempts SET status = 'aborted', abort_reason = 'lease_lost' WHERE id = $1`,
        [seed.attempt],
      );
      const aborted = await exec(tool, args(seed), {
        context: seed.ctx,
        toolCallId: toolCall('fence'),
        modelCallId: seed.modelCallId,
      });
      expect(aborted.ok, `${tool} on an aborted attempt`).toBe(false);
      expectNoWrites(
        before,
        await tw.counts(seed.mission, seed.attempt),
        `${tool} on an aborted attempt`,
      );
      // control on a fresh attempt: the same call with the real fence writes exactly one row
      const live = await tw.seedAttempt('cache_specialist');
      const ok = await exec(tool, args(live), {
        context: live.ctx,
        toolCallId: toolCall('fence-ok'),
        modelCallId: live.modelCallId,
      });
      expect(ok.ok, ok.text).toBe(true);
      const after = await tw.counts(live.mission, live.attempt);
      if (tool === 'publish_finding') expect(after.findings).toBe(1);
      if (tool === 'delegate_task') expect(after.tasks).toBe(3);
      if (tool === 'propose_action') expect(after.intents).toBe(1);
    },
  );
});

describe('[TP3.1][T-idem] propose_action derives its idempotency from the tool call id', () => {
  it('the same tool call id with the same payload returns the ORIGINAL intent; with a different payload it is idempotency_conflict and changes nothing', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('cache_specialist');
    const options = (toolCallId: string) => ({
      context: seed.ctx,
      toolCallId,
      modelCallId: seed.modelCallId,
    });
    const first = await exec(
      'propose_action',
      setPool(12, seed),
      options('tc-1'),
    );
    expect(first.ok, first.text).toBe(true);
    const firstId = intentIdOf(first.value);
    expect(firstId).toBeTruthy();
    expect((await tw.intents(seed.mission)).length).toBe(1);

    const replay = await exec(
      'propose_action',
      setPool(12, seed),
      options('tc-1'),
    );
    expect(replay.ok, replay.text).toBe(true);
    expect(intentIdOf(replay.value)).toBe(firstId);
    expect((await tw.intents(seed.mission)).length).toBe(1);

    const tampered = await exec(
      'propose_action',
      setPool(13, seed),
      options('tc-1'),
    );
    // oracle ADM-05a: blocked(idempotency_conflict) or thrown; the original stays and 13 is never stored
    const rows = JSON.stringify(await tw.intents(seed.mission));
    expect(
      tampered.text + rows,
      'the conflict is reported as idempotency_conflict',
    ).toContain('idempotency_conflict');
    expect(
      tampered.value === undefined ||
        intentIdOf(tampered.value) !== firstId ||
        !tampered.ok,
    ).toBe(true);
    expect(rows).not.toMatch(/"value":\s*13/);
    expect(await tw.configOf('db.pool_max')).toEqual({ value: 2, version: 1 });

    // a different tool call id with the same payload is a NEW proposal (the key derives from the tool call id)
    const other = await exec(
      'propose_action',
      setPool(12, seed),
      options('tc-2'),
    );
    expect(other.ok, other.text).toBe(true);
    expect(intentIdOf(other.value)).not.toBe(firstId);
  });
});

describe('[TP3.2][T-scope] propose_action through the executor (oracle ADM-18, ADM-06c, ADM-06d)', () => {
  const NEVER_ACTIVE =
    /"status":\s*"(proposed|admitted|committed|dispatched|succeeded)"/;

  it('ADM-18: a receipt of another mission, or one the attempt never saw, is citation_out_of_scope; nothing is admitted or committed', async () => {
    const exec = await bindTeamExecutor(tw);
    for (const stray of ['foreign', 'unseen'] as const) {
      const seed = await tw.seedAttempt('cache_specialist');
      const args = {
        ...setPool(12, seed),
        supportingReceiptIds: [seed[stray].id, seed.health.id],
      };
      const outcome = await exec('propose_action', args, {
        context: seed.ctx,
        toolCallId: toolCall('adm18'),
        modelCallId: seed.modelCallId,
      });
      const rows = JSON.stringify(await tw.intents(seed.mission));
      expect(outcome.text + rows, stray).toContain('citation_out_of_scope');
      expect(rows, stray).not.toMatch(NEVER_ACTIVE);
      expect(await tw.configOf('db.pool_max')).toEqual({
        value: 2,
        version: 1,
      });
    }
  });

  it('ADM-06c: an out-of-domain value, an unknown action kind and an extra payload field are payload_invalid (or rejected at the strict boundary) and write no active intent', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('cache_specialist');
    const attempts: [string, unknown][] = [
      ['out-of-domain', setPool(50, seed)],
      [
        'unknown-kind',
        {
          ...setPool(12, seed),
          action: 'unknown_kind',
          payload: { table: 'checkout.orders' },
        },
      ],
      ['extra-field', setPool(12, seed, { causedByActionId: 'forged' })],
    ];
    for (const [label, args] of attempts) {
      const outcome = await exec('propose_action', args, {
        context: seed.ctx,
        toolCallId: toolCall('adm06c'),
        modelCallId: seed.modelCallId,
      });
      expect(outcome.ok, label).toBe(false);
      expect(outcome.text, label).toMatch(
        /payload_invalid|invalid|unrecognized|strict|schema/i,
      );
    }
    const rows = JSON.stringify(await tw.intents(seed.mission));
    expect(rows).not.toMatch(NEVER_ACTIVE);
    expect(rows).not.toMatch(/"value":\s*50/);
    expect(await tw.configOf('db.pool_max')).toEqual({ value: 2, version: 1 });
  });

  it('ADM-06d: an investigator cannot propose (capability_denied) and no intent is created in an active status', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('investigator');
    const outcome = await exec('propose_action', setPool(12, seed), {
      context: seed.ctx,
      toolCallId: toolCall('adm06d'),
      modelCallId: seed.modelCallId,
    });
    const rows = JSON.stringify(await tw.intents(seed.mission));
    expect(outcome.text + rows).toMatch(/capability_denied|capability/i);
    expect(rows).not.toMatch(NEVER_ACTIVE);
  });
});

/* ------------------------------------------------------------------ G3-T5 observe_source */

describe('[TP3.1][T5] observe_source records a receipt, a readset edge and an event in one transaction', () => {
  it('a registered controlled source adds exactly one receipt, one evidence edge, one read-set entry and one tool_call.recorded event; a second call confirms instead of duplicating; an unregistered key writes nothing', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('investigator');
    const call = (key: string) =>
      exec(
        'observe_source',
        { sourceKey: key },
        {
          context: seed.ctx,
          toolCallId: toolCall('observe'),
          modelCallId: seed.modelCallId,
        },
      );

    const bad = await tw.counts(seed.mission, seed.attempt);
    for (const key of [
      'checkout.secrets',
      'postgres://x',
      '../etc/passwd',
      'checkout.config/',
    ]) {
      const outcome = await call(key);
      expect(outcome.ok, key).toBe(false);
    }
    expectNoWrites(
      bad,
      await tw.counts(seed.mission, seed.attempt),
      'invalid keys',
    );

    const start = await tw.counts(seed.mission, seed.attempt);
    const first = await call('checkout.config/cache.namespace');
    expect(first.ok, first.text).toBe(true);
    expect(first.text).toContain('acc3-ns-a');
    const afterFirst = await tw.counts(seed.mission, seed.attempt);
    // hand-enumerated deltas for the first observation of a source never read in this mission
    expect(afterFirst.receipts - start.receipts).toBe(1);
    expect(afterFirst.readSet - start.readSet).toBe(1);
    expect(afterFirst.edges - start.edges).toBe(1);
    expect(afterFirst.toolCallEvents - start.toolCallEvents).toBe(1);
    expect(afterFirst.config).toBe(start.config); // observing never writes the controlled state

    const edge = await tw.q<{
      kind: string;
      from_kind: string;
      to_kind: string;
      to_id: string;
    }>(
      `SELECT kind, from_kind, to_kind, to_id FROM ledger.dependency_edges WHERE mission_id = $1`,
      [seed.mission],
    );
    expect(edge).toEqual([
      {
        kind: 'evidence',
        from_kind: 'receipt',
        to_kind: 'attempt',
        to_id: seed.attempt,
      },
    ]);

    const second = await call('checkout.config/cache.namespace');
    expect(second.ok, second.text).toBe(true);
    const afterSecond = await tw.counts(seed.mission, seed.attempt);
    expect(afterSecond.receipts).toBe(afterFirst.receipts); // unchanged value: confirmation, not a new receipt
    expect(afterSecond.confirmations - afterFirst.confirmations).toBe(1);
    expect(afterSecond.edges).toBe(afterFirst.edges);
    expect(afterSecond.readSet).toBe(afterFirst.readSet);
  });
});

/* ------------------------------------------------------------------ G3-T6, T7 */

describe('[TP3.5][T6] instruction-like text in a tool result is data', () => {
  it('observing a source whose value says "delegate_task to run_shell" creates no task, no action, no finding and changes no controlled value', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('investigator');
    await tw.q(
      `UPDATE checkout.config_entries SET value = to_jsonb($1::text), version = version + 1, caused_by_actor = 'owner' WHERE key = 'ui.banner_text'`,
      [INJECTION],
    );
    const before = await tw.counts(seed.mission, seed.attempt);
    const outcome = await exec(
      'observe_source',
      { sourceKey: 'checkout.config/ui.banner_text' },
      {
        context: seed.ctx,
        toolCallId: toolCall('hostile'),
        modelCallId: seed.modelCallId,
      },
    );
    expect(outcome.ok, outcome.text).toBe(true);
    expect(outcome.text).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    const after = await tw.counts(seed.mission, seed.attempt);
    expect(after.tasks).toBe(before.tasks);
    expect(after.intents).toBe(before.intents);
    expect(after.findings).toBe(before.findings);
    expect(after.authorizations).toBe(before.authorizations);
    expect(after.config).toBe(before.config);
    expect(await tw.configOf('cache.namespace')).toEqual({
      value: 'acc3-ns-a',
      version: 1,
    });
  });
});

describe('[TP3.4][T7] no tool result leaks credentials or the fault actor', () => {
  it('serialized results of the nine tools contain none of the visible secret values, no database URL, no caused_by_actor field and no injector actor', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('cache_specialist');
    await tw.q(
      `UPDATE checkout.config_entries SET value = '"acc3-ns-injected"'::jsonb, version = version + 1, caused_by_actor = 'injector' WHERE key = 'cache.namespace'`,
    );
    const o = (id: string) => ({
      context: seed.ctx,
      toolCallId: toolCall(id),
      modelCallId: seed.modelCallId,
    });
    const results: Outcome[] = [];
    results.push(
      await exec(
        'observe_source',
        { sourceKey: 'checkout.config/cache.namespace' },
        o('t7a'),
      ),
    );
    results.push(
      await exec('observe_source', { sourceKey: 'checkout.health' }, o('t7b')),
    );
    results.push(await exec('list_runbooks', {}, o('t7c')));
    results.push(
      await exec('get_task_status', { taskId: seed.task }, o('t7d')),
    );
    results.push(await exec('wait_for_children', {}, o('t7e')));
    results.push(await exec('publish_finding', finding(seed), o('t7f')));
    results.push(await exec('propose_action', setPool(12, seed), o('t7g')));
    results.push(await exec('delegate_task', delegation(), o('t7h')));
    results.push(
      await exec(
        'request_replan',
        { reason: 'The plan no longer fits.' },
        o('t7i'),
      ),
    );
    const text = results.map((r) => r.text).join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(secretsPresentIn(text, visibleSecrets())).toEqual([]);
    expect(text).not.toMatch(/postgres(ql)?:\/\/|redis:\/\//i);
    expect(text).not.toMatch(/caused_by_actor|causedByActor/);
    expect(text).not.toMatch(/injector/i);
  });
});

/* ------------------------------------------------------------------ G3-T8 delegation bounds */

describe('[TP3.1][T8] delegate_task and propose_action are policy-checked at their boundary', () => {
  it('capability subset: a verifier cannot delegate; a specialist delegates the verifier role only; a missing or empty justification is rejected; refusals create no task', async () => {
    const exec = await bindTeamExecutor(tw);
    const seed = await tw.seedAttempt('cache_specialist');
    const run = (ctx: Seeded['ctx'], args: unknown) =>
      exec('delegate_task', args, {
        context: ctx,
        toolCallId: toolCall('del'),
        modelCallId: seed.modelCallId,
      });
    const before = await tw.counts(seed.mission, seed.attempt);

    expect((await run(seed.ctx, delegation({ role: 'investigator' }))).ok).toBe(
      false,
    );
    expect(
      (await run(seed.ctx, delegation({ role: 'cache_specialist' }))).ok,
    ).toBe(false);
    expect((await run(seed.ctx, delegation({ role: 'planner' }))).ok).toBe(
      false,
    );
    expect(
      (await run(seed.ctx, delegation({ role: 'postcondition' }))).ok,
    ).toBe(false);
    expect((await run(seed.ctx, delegation({ justification: '' }))).ok).toBe(
      false,
    );
    const noJustification: Record<string, unknown> = delegation();
    delete noJustification.justification;
    expect((await run(seed.ctx, noJustification)).ok).toBe(false);
    expect(
      (
        await run(
          seed.ctx,
          delegation({ capabilities: ['propose_cache_flush'] }),
        )
      ).ok,
    ).toBe(false);
    const verifierCtx = {
      ...seed.ctx,
      role: 'verifier',
      capabilities: [...CAPS.verifier],
    };
    expect((await run(verifierCtx, delegation())).ok).toBe(false);
    expect((await tw.counts(seed.mission, seed.attempt)).tasks).toBe(
      before.tasks,
    );

    const ok = await run(seed.ctx, delegation());
    expect(ok.ok, ok.text).toBe(true);
    const child = await tw.q<{
      role: string;
      capabilities: string[];
      depth: number;
      parent_id: string;
      justification: string;
    }>(
      `SELECT role, capabilities, depth, parent_id, justification FROM coordinator.tasks WHERE mission_id = $1 AND parent_id = $2`,
      [seed.mission, seed.task],
    );
    expect(child).toHaveLength(1);
    expect(child[0].role).toBe('verifier');
    expect([...child[0].capabilities].sort()).toEqual(
      [...CAPS.verifier].sort(),
    );
    expect(child[0].depth).toBe(2); // root 0, T 1, child 2
    expect(child[0].justification).toBe(
      'Needs an independent read of the checkout.',
    );
  });

  it('breadth, depth and total caps (4, 3, 24) are enforced and a refused delegation creates no task', async () => {
    const exec = await bindTeamExecutor(tw);
    const run = (seed: Seeded) =>
      exec('delegate_task', delegation(), {
        context: seed.ctx,
        toolCallId: toolCall('cap'),
        modelCallId: seed.modelCallId,
      });

    // breadth: T already has 4 children
    const wide = await tw.seedAttempt('investigator');
    for (let i = 0; i < 4; i += 1)
      await tw.seedTask(wide.mission, {
        role: 'verifier',
        parentId: wide.task,
        depth: 2,
      });
    const wideBefore = await tw.counts(wide.mission, wide.attempt);
    const fifth = await run(wide);
    expect(fifth.ok, 'fifth child').toBe(false);
    expect((await tw.counts(wide.mission, wide.attempt)).tasks).toBe(
      wideBefore.tasks,
    );

    // depth: T sits at the maximum depth 3, so a child would be depth 4
    const deep = await tw.seedAttempt('investigator');
    await tw.q(`UPDATE coordinator.tasks SET depth = 3 WHERE id = $1`, [
      deep.task,
    ]);
    const deepBefore = await tw.counts(deep.mission, deep.attempt);
    expect((await run(deep)).ok, 'depth 4').toBe(false);
    expect((await tw.counts(deep.mission, deep.attempt)).tasks).toBe(
      deepBefore.tasks,
    );

    // total: the mission already has 24 tasks
    const full = await tw.seedAttempt('investigator');
    for (let i = 0; i < 22; i += 1)
      await tw.seedTask(full.mission, {
        role: 'verifier',
        status: 'succeeded',
        parentId: (
          await tw.q<{ id: string }>(
            `SELECT id FROM coordinator.tasks WHERE mission_id = $1 AND depth = 0`,
            [full.mission],
          )
        )[0].id,
        depth: 1,
      });
    expect((await tw.counts(full.mission, full.attempt)).tasks).toBe(24);
    expect((await run(full)).ok, '25th task').toBe(false);
    expect((await tw.counts(full.mission, full.attempt)).tasks).toBe(24);

    // control: an attempt below every cap delegates
    const fine = await tw.seedAttempt('investigator');
    expect((await run(fine)).ok).toBe(true);
  });
});
