// TEST_PROMPT gate 5 cases 3, 4 (unused paths) and 8, driven through the
// running NemoDots app over its documented HTTP routes (contracts/routes.ts,
// prefix /api/nemodots). The app must be listening on the acc5 app port
// (NEMODOTS_ACC5_APP_URL, default http://127.0.0.1:4701). If it is not, these
// cases FAIL with "entry point missing: app not reachable"; they are never
// skipped.
//
//  G5.3 redacted request receipts for planner, specialist(worker), verifier
//       reasoning and changed-evidence replanning, all on Crusoe/Nemotron
//  G5.4 (app level) provider outage blocks the mission; a mutating action is
//       never auto-retried
//  G5.5 unused voice / Learning / research / connector inference paths are
//       disabled (configuration AND observable app state)
//  G5.8 inference tokens and monitoring tokens are separate
//
// Expected values come from TEST_PROMPT gate 5 and ACCEPTANCE_CONTRACT 4.3.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_HOST,
  PRIMARY_MODEL,
  appEnv,
  assertNoSecret,
  loadModule,
  requireLive,
  startProxy,
  type LiveEnv,
  type Proxy,
} from './support.js';

const APP = (
  process.env.NEMODOTS_ACC5_APP_URL ?? 'http://127.0.0.1:4701'
).replace(/\/+$/, '');
const API = `${APP}/api/nemodots`;
// Second app instance whose OPENAI_BASE_URL is the verifier proxy on PROXY_PORT
// (ACCEPTANCE_CONTRACT section 6, Provider). Not started by the suite.
const PROXIED_APP = (
  process.env.NEMODOTS_ACC5_PROXIED_APP_URL ?? 'http://127.0.0.1:4702'
).replace(/\/+$/, '');
const PROXY_PORT = Number(process.env.NEMODOTS_ACC5_PROXY_PORT ?? 4710);
const SPECIALIST_ROLES = [
  'cache_specialist',
  'database_specialist',
  'routing_specialist',
];

let live: LiveEnv;

async function api(
  method: string,
  path: string,
  body?: unknown,
  base: string = API,
): Promise<{ status: number; json: any; text: string }> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      `ENTRY POINT MISSING: NemoDots app not reachable at ${base} (${(error as Error).message.slice(0, 100)}). Start it on the acc5 port block (app 4701, checkout 4700) before running Gate 5 app cases.`,
    );
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

type Ev = {
  id?: number;
  payload?: { kind: string; [k: string]: any };
  kind?: string;
  [k: string]: any;
};
const kindOf = (e: Ev) => e.payload?.kind ?? e.kind;
const bodyOf = (e: Ev) => (e.payload ?? e) as Record<string, any>;

/** Reads the mission's event stream for up to `ms`, tolerating SSE or a JSON array. */
async function readEvents(
  missionId: string,
  ms: number,
  base: string = API,
): Promise<Ev[]> {
  const out: Ev[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${base}/missions/${missionId}/events`, {
      headers: { accept: 'text/event-stream, application/json' },
      signal: controller.signal,
    });
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const j = await res.json();
      return (Array.isArray(j) ? j : (j.events ?? [])) as Ev[];
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (!data) continue;
        try {
          out.push(JSON.parse(data));
        } catch {
          /* heartbeat or partial */
        }
      }
    }
  } catch {
    /* aborted on purpose */
  } finally {
    clearTimeout(timer);
  }
  return out;
}

beforeAll(() => {
  live = requireLive();
});

const arr = (j: any, key: string): any[] =>
  Array.isArray(j) ? j : Array.isArray(j?.[key]) ? j[key] : [];

/**
 * ModelCallRecord / ContextSnapshot are not on the event variant (events carry
 * ids, role, model, provider only), so full receipts come from the snapshot or
 * evidence routes. Dependency: one of them must expose `modelCalls` and
 * `contextSnapshots`; if neither does, the field assertions below FAIL.
 */
async function loadReceipts(missionId: string, base: string = API) {
  const [snap, evidence, tasksRes] = await Promise.all([
    api('GET', `/missions/${missionId}`, undefined, base),
    api('GET', `/missions/${missionId}/evidence`, undefined, base),
    api('GET', `/missions/${missionId}/tasks`, undefined, base),
  ]);
  const pick = (k: string) => [
    ...arr(evidence.json, k),
    ...(Array.isArray(snap.json?.[k]) ? snap.json[k] : []),
  ];
  return {
    snapshot: snap.json,
    tasks: arr(tasksRes.json, 'tasks').length
      ? arr(tasksRes.json, 'tasks')
      : arr(snap.json, 'tasks'),
    records: pick('modelCalls') as Record<string, any>[],
    snapshots: pick('contextSnapshots') as Record<string, any>[],
    invalidations: arr(snap.json, 'invalidations') as Record<string, any>[],
  };
}

describe('G5.5 unused voice / Learning / research / connector inference paths are disabled', () => {
  it('G5.5a the environment the app boots with leaves every non-Crusoe model path unconfigured', () => {
    const env = appEnv();
    const empty = (n: string) => (env[n] ?? '').trim() === '';
    // TOOL_COVERAGE.md R9/R9b, LEAD_NOTES "External dependencies": disabled for the incident scope.
    expect.soft(empty('VOICE_API_KEY'), 'voice key set').toBe(true);
    expect.soft(empty('COMPOSIO_API_KEY'), 'Composio key set').toBe(true);
    expect
      .soft(empty('PARALLEL_API_KEY'), 'Parallel research key set')
      .toBe(true);
    expect
      .soft(
        env.WEB_SEARCH_PROVIDER,
        'TOOL_COVERAGE R9 requires WEB_SEARCH_PROVIDER=disabled',
      )
      .toBe('disabled');
    expect
      .soft(
        empty('BROWSER_URL'),
        'TOOL_COVERAGE R9b requires BROWSER_URL unset',
      )
      .toBe(true);
    expect
      .soft(
        empty('COMPUTER_SUPERVISOR_URL') &&
          empty('COMPUTER_TOKEN') &&
          empty('COMPUTER_SUPERVISOR_TOKEN'),
        'computer service configured (URL, COMPUTER_TOKEN or COMPUTER_SUPERVISOR_TOKEN set)',
      )
      .toBe(true);
    expect
      .soft(
        empty('SLACK_TEAM_ID') &&
          empty('SLACK_CHANNEL_NAME') &&
          empty('SLACK_USER_IDS'),
        'Slack configured',
      )
      .toBe(true);
    // The only inference provider is the one Crusoe base URL.
    expect.soft(new URL(env.OPENAI_BASE_URL!).host).toBe(EXPECTED_HOST);
  });

  it('G5.5b the running app reports live mode on Crusoe with the requested model listed (no second provider in /health)', async () => {
    const h = await api('GET', '/health');
    expect(h.status).toBe(200);
    expect(h.json.mode).toBe('live');
    expect(h.json.provider.host).toBe(EXPECTED_HOST);
    expect(h.json.provider.model).toBe(PRIMARY_MODEL);
    expect(h.json.provider.reachable).toBe(true);
    expect(h.json.provider.modelListed).toBe(true);
    assertNoSecret(h.text, live.apiKey);
  });

  it('G5.5c observable app state: no Dot has Automatic Learning, skill delivery, research, connected apps or Composio toolkits enabled (Intelligence conversations stay on, Learning stays off)', async () => {
    // Configuration cannot prove a path is disabled; the workspace the running
    // app serves can. LEAD_NOTES: Intelligence available, Learning/Slack/voice off.
    const w = await api('GET', '/workspace', undefined, `${APP}/api`);
    expect(w.status, 'GET /api/workspace').toBe(200);
    expect(Array.isArray(w.json.dots)).toBe(true);
    for (const d of w.json.dots as Record<string, any>[]) {
      const who = `dot ${d.id ?? '?'}`;
      expect(
        d.learningContainerId ?? null,
        `${who} learning container`,
      ).toBeNull();
      expect(d.skillDeliveryEnabled ?? false, `${who} skill delivery`).toBe(
        false,
      );
      expect(d.researchAllowed ?? false, `${who} research`).toBe(false);
      expect(d.appsAllowed ?? false, `${who} connected apps`).toBe(false);
      expect(d.composioToolkits ?? [], `${who} Composio toolkits`).toEqual([]);
    }
    // a Slack channel or voice call must not exist either
    expect(w.json.calls ?? []).toEqual([]);
    assertNoSecret(w.text, live.apiKey);
  });
});

describe('G5.3 + G5.8 a live mission: redacted per-role receipts on Crusoe/Nemotron and separate token accounting', () => {
  let missionId = '';
  let events: Ev[] = [];
  let calls: Record<string, any>[] = [];
  let tasks: Record<string, any>[] = [];
  let snapshots: Record<string, any>[] = [];
  let summaryBefore: any;

  const sum = (rows: Record<string, any>[], k: string) =>
    rows.reduce((n, c) => n + (c.usage?.[k] ?? 0), 0);

  it('G5.3a run a neutral-goal mission with a mid-run dependent change and collect its model-call receipts', async () => {
    summaryBefore = (await api('GET', '/telemetry/summary')).json;
    const created = await api('POST', '/missions', {
      goal: 'Keep the checkout service healthy and make sure what the team believes about it is current.',
      mode: 'live',
    });
    expect([200, 201]).toContain(created.status);
    missionId = created.json.id ?? created.json.mission?.id;
    expect(missionId).toBeTruthy();
    const started = await api('POST', `/missions/${missionId}/start`, {});
    expect([200, 202]).toContain(started.status);
    // sandbox scenario with a dependent change after the first proposal (IMPLEMENTATION_STATUS W3)
    const inj = await api('POST', '/sandbox/injector/run', {
      scenarioClass: 'dependent_change_after_proposal',
    });
    expect([200, 201, 202]).toContain(inj.status);

    const terminal = [
      'succeeded',
      'failed',
      'cancelled',
      'awaiting_acceptance',
    ];
    const deadline = Date.now() + 9 * 60_000;
    let status = '';
    while (Date.now() < deadline) {
      const m = await api('GET', `/missions/${missionId}`);
      status = m.json?.mission?.status ?? m.json?.status ?? '';
      if (terminal.includes(status)) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    expect(
      terminal,
      `mission did not settle (last status "${status}")`,
    ).toContain(status);
    events = await readEvents(missionId, 6000);
    const fromEvents = events
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => kindOf(e) === 'model_call.recorded')
      .map(({ e, idx }): Record<string, any> => ({ ...bodyOf(e), _idx: idx }));
    expect(fromEvents.length).toBeGreaterThan(0);
    const r = await loadReceipts(missionId);
    tasks = r.tasks;
    snapshots = r.snapshots;
    const byId = new Map(r.records.map((x) => [x.id ?? x.modelCallId, x]));
    // full ModelCallRecord fields override the slim event payload
    calls = fromEvents.map((c) => ({
      ...c,
      ...(byId.get(c.modelCallId) ?? {}),
    }));
    expect(calls.length).toBeGreaterThan(0);
  }, 700_000);

  it('G5.3b every receipt is live, on the configured Crusoe host, requested == returned == the primary Nemotron model, and carries no secret', () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.provider).toEqual({ host: EXPECTED_HOST, mode: 'live' });
      expect(c.model.requested).toBe(PRIMARY_MODEL);
      if (c.outcome !== 'failed' && c.outcome !== 'aborted')
        expect(c.model.returned).toBe(c.model.requested);
      const snap = snapshots.find(
        (x) => x.id === (c.contextSnapshotId ?? c.snapshotId),
      );
      const prefixDigest = c.prefixDigest ?? snap?.prefixDigest;
      const contextDigest = c.contextDigest ?? snap?.contextDigest;
      expect(prefixDigest, 'prefixDigest not exposed by any route').toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(contextDigest, 'contextDigest not exposed by any route').toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(c.attempts).toBeGreaterThanOrEqual(1);
    }
    assertNoSecret(events, live.apiKey);
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/);
    expect(text).not.toMatch(/postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/prompt"\s*:/); // receipts are redacted: no raw prompt text
  });

  it('G5.3c planner, specialist (task role), verifier (task role) and changed-evidence replan calls all appear, are live on Crusoe, and the replan is tied to the invalidation', () => {
    // ModelRole has no 'verifier'; specialist and verifier calls are role
    // 'worker'. Join each call to its TASK role (GET /missions/:id/tasks).
    const taskRole = new Map(tasks.map((x) => [x.id, x.role]));
    const joined: Record<string, any>[] = calls.map((c) => ({
      ...c,
      taskRole: taskRole.get(c.taskId),
    }));
    const unjoined = joined.filter((c) => c.taskRole === undefined);
    expect(
      unjoined.length,
      `${unjoined.length} model calls name a task absent from /missions/:id/tasks`,
    ).toBe(0);
    const good = (c: any) =>
      c.provider?.mode === 'live' &&
      c.provider?.host === EXPECTED_HOST &&
      c.outcome !== 'failed' &&
      c.outcome !== 'aborted';

    expect(
      joined.some((c) => c.role === 'planner' && good(c)),
      'live planner call missing',
    ).toBe(true);
    expect(
      joined.some((c) => c.taskRole === 'verifier' && good(c)),
      'no live, non-failed model call from a task with role "verifier" (verifier reasoning)',
    ).toBe(true);
    const specialists = new Set(
      joined
        .filter((c) => SPECIALIST_ROLES.includes(c.taskRole) && good(c))
        .map((c) => c.taskRole),
    );
    // "specialists" (TEST_PROMPT): at least one specialist role must have run
    // on Crusoe; one suffices because the incident may implicate one subsystem
    // (ACCEPTANCE_CONTRACT Gate 5 clarifications).
    expect(
      specialists.size,
      'no live model call from a cache/database/routing specialist task',
    ).toBeGreaterThanOrEqual(1);

    // changed-evidence replanning: tie the replan to the invalidation
    const invalidations = events
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => kindOf(e) === 'invalidation.recorded')
      .map(({ e, idx }): Record<string, any> => ({ ...bodyOf(e), _idx: idx }));
    expect(
      invalidations.length,
      'no invalidation.recorded event',
    ).toBeGreaterThan(0);
    const replans = joined.filter((c) => c.role === 'replan' && good(c));
    expect(replans.length, 'no live replan call').toBeGreaterThan(0);
    const snapOf = (c: any) =>
      snapshots.find((x) => x.id === (c.contextSnapshotId ?? c.snapshotId));
    const linked = replans.flatMap((rp) =>
      invalidations
        .filter((inv) => inv._idx < rp._idx)
        .filter((inv) => {
          const snap = snapOf(rp);
          if (!snap) return false;
          const injected = snap.injected ?? {};
          const byEvent = (injected.invalidationEvents ?? []).includes(
            inv.invalidationEventId,
          );
          const vec: any[] = snap.dependencyVector ?? [];
          const carriesNew =
            inv.newReceiptId !== null &&
            (vec.some((v) => v.receiptId === inv.newReceiptId) ||
              (injected.receipts ?? []).some(
                (r: any) => r.id === inv.newReceiptId,
              ));
          const carriesStale = vec.some(
            (v) => v.receiptId === inv.oldReceiptId,
          );
          return (byEvent || carriesNew) && !carriesStale;
        })
        .map((inv) => ({ rp, inv })),
    );
    expect(
      linked.length,
      'no replan call whose context snapshot injects the invalidation (or carries the post-change receipt) without the superseded receipt; is ContextSnapshot exposed on a route?',
    ).toBeGreaterThan(0);
    // and its context differs from the pre-change planner's
    const { rp, inv } = linked[0];
    const prePlanner = joined
      .filter((c) => c.role === 'planner' && c._idx < inv._idx)
      .at(-1);
    expect(prePlanner, 'no planner call before the invalidation').toBeTruthy();
    const ctxDigest = (c: any) => c.contextDigest ?? snapOf(c)?.contextDigest;
    expect(ctxDigest(rp)).toMatch(/^[0-9a-f]{64}$/);
    expect(ctxDigest(rp)).not.toBe(ctxDigest(prePlanner));
  });

  it('G5.3d cached tokens in receipts are null (unavailable) or a non-negative integer never above prompt tokens', () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const u = c.usage;
      expect(u).toBeTruthy();
      for (const k of [
        'promptTokens',
        'completionTokens',
        'cachedTokens',
        'reasoningTokens',
      ])
        expect(
          u[k] === null || (Number.isInteger(u[k]) && u[k] >= 0),
          `${k}=${u[k]}`,
        ).toBe(true);
      if (u.cachedTokens !== null && u.promptTokens !== null)
        expect(u.cachedTokens).toBeLessThanOrEqual(u.promptTokens);
      if (c.outcome === 'aborted')
        expect(Object.values(u)).toEqual([null, null, null, null]);
    }
  });

  it('G5.3e compatible calls share a prefix: calls of the same role in this mission group under a small number of prefix digests', async () => {
    const t = await api('GET', `/missions/${missionId}/telemetry`);
    expect(t.status).toBe(200);
    const groups: { prefixDigest: string; calls: number }[] =
      t.json.prefixGroups;
    expect(groups.reduce((n, g) => n + g.calls, 0)).toBe(calls.length);
    // the stable-prefix claim only means something if groups actually repeat
    expect(
      groups.some((g) => g.calls >= 2),
      'no prefix digest was ever reused',
    ).toBe(true);
    const digests = new Set(
      calls
        .map(
          (c) =>
            c.prefixDigest ??
            snapshots.find(
              (x) => x.id === (c.contextSnapshotId ?? c.snapshotId),
            )?.prefixDigest,
        )
        .filter(Boolean),
    );
    expect(groups.length).toBe(digests.size);
  });

  it('G5.8a telemetry token totals are exactly the sum of the inference receipts (aggregate provider metrics are not used as per-mission spans)', async () => {
    const t = await api('GET', `/missions/${missionId}/telemetry`);
    expect(t.json.calls).toBe(calls.length);
    expect(t.json.tokens.prompt).toBe(sum(calls, 'promptTokens'));
    expect(t.json.tokens.completion).toBe(sum(calls, 'completionTokens'));
    const anyCached = calls.some((c) => c.usage.cachedTokens !== null);
    expect(t.json.tokens.cached.available).toBe(anyCached);
    if (anyCached)
      expect(t.json.tokens.cached.total).toBe(sum(calls, 'cachedTokens'));
    else expect(t.json.tokens.cached.total).toBeNull();
    if (t.json.ttftMs !== null) {
      expect(t.json.ttftMs.p50).toBeGreaterThanOrEqual(0);
      expect(t.json.ttftMs.p95).toBeGreaterThanOrEqual(t.json.ttftMs.p50);
    }
  });

  it('G5.8b positive control: the app-wide summary moved by exactly the mission receipts (calls, prompt and completion tokens)', async () => {
    const after = (await api('GET', '/telemetry/summary')).json;
    expect(after.calls - summaryBefore.calls).toBe(calls.length);
    expect(after.tokens.prompt - summaryBefore.tokens.prompt).toBe(
      sum(calls, 'promptTokens'),
    );
    expect(after.tokens.completion - summaryBefore.tokens.completion).toBe(
      sum(calls, 'completionTokens'),
    );
    // a constant or always-zero summary would fail here
    expect(after.tokens.prompt).toBeGreaterThan(0);
  });

  it('G5.8c monitoring traffic (health, checkout health, repeated model-availability probes) adds nothing to the inference totals', async () => {
    const before = (await api('GET', '/telemetry/summary')).json;
    for (let i = 0; i < 3; i++) {
      const h = await api('GET', '/health');
      expect(h.status).toBe(200);
      expect(h.json.provider.modelListed).toBe(true); // the availability probe really ran
    }
    await api('GET', '/sandbox/checkout/health');
    const after = (await api('GET', '/telemetry/summary')).json;
    expect(after.calls).toBe(before.calls);
    expect(after.tokens.prompt).toBe(before.tokens.prompt);
    expect(after.tokens.completion).toBe(before.tokens.completion);
    expect(after.tokens.cached).toEqual(before.tokens.cached);
  }, 60_000);

  it('G5.8d an OpenDots dot-agent chat turn (same OPENAI_* provider) is excluded from mission/inference totals, or reported under a separate labeled bucket', async () => {
    const w = await api('GET', '/workspace', undefined, `${APP}/api`);
    const dot = (w.json?.dots ?? [])[0];
    expect(
      dot,
      'ENTRY POINT MISSING: no OpenDots Dot to drive a chat turn through',
    ).toBeTruthy();
    const conv = await api(
      'POST',
      '/conversations',
      { dotId: dot.id, title: 'acc5 monitoring' },
      `${APP}/api`,
    );
    expect(conv.status, 'POST /api/conversations').toBe(201);
    const threadId = conv.json.threadId ?? conv.json.id;
    expect(threadId).toBeTruthy();
    const headless = await loadModule<{
      runThreadTurn: (
        runtimeUrl: string,
        headers: Record<string, string>,
        dotId: string,
        threadId: string,
        prompt: string,
        signal: AbortSignal,
      ) => Promise<string>;
    }>('src/server/headless.ts');
    const before = (await api('GET', '/telemetry/summary')).json;
    const reply = await headless.runThreadTurn(
      `${APP}/api/copilotkit`,
      {},
      dot.id,
      threadId,
      'Reply with exactly: OK',
      AbortSignal.timeout(120_000),
    );
    expect(reply.length).toBeGreaterThan(0);
    const after = (await api('GET', '/telemetry/summary')).json;
    // Either excluded entirely...
    const unchanged =
      after.calls === before.calls &&
      after.tokens.prompt === before.tokens.prompt &&
      after.tokens.completion === before.tokens.completion;
    // ...or surfaced under its own labeled bucket, never merged into mission totals.
    const labeled = Object.keys(after).some((k) =>
      /monitor|dot|chat|other/i.test(k),
    );
    expect(
      unchanged || labeled,
      'chat-turn tokens were merged into the mission/inference totals without a separate bucket',
    ).toBe(true);
  }, 200_000);

  it('G5.4m a mutating action is dispatched at most once per idempotency key: results never repeat and no retry attempt re-dispatches', async () => {
    const r = await loadReceipts(missionId);
    const results: Record<string, any>[] = r.snapshot?.results ?? [];
    const byKey = new Map<string, number>();
    for (const x of results)
      byKey.set(x.idempotencyKey, (byKey.get(x.idempotencyKey) ?? 0) + 1);
    for (const [key, n] of byKey)
      expect(
        n,
        `idempotency key ${key.slice(0, 12)} produced ${n} results`,
      ).toBe(1);
    // an outcome_unknown action is reconciled, never re-dispatched
    const actions: Record<string, any>[] = r.snapshot?.actions ?? [];
    for (const a of actions.filter((x) => x.status === 'outcome_unknown'))
      expect(
        results.filter((x) => x.actionId === a.id).length,
        `outcome_unknown action ${a.id} was dispatched again`,
      ).toBeLessThanOrEqual(1);
    // Dependency: a fault-driven variant (NEMODOTS_TEST_HOOKS barrier
    // after_effect_before_record + checkout write count == 1) lives in g2/g3.
  });
});

describe('G5.4l app-level provider outage: the mission blocks instead of completing, switching vendor or answering from fixtures', () => {
  let proxy: Proxy | undefined;
  afterAll(async () => proxy?.close());

  it('G5.4l a running mission whose OPENAI_BASE_URL (the verifier proxy) goes permanently dark ends in blocked_provider with no completed call after the outage', async () => {
    let dark = false;
    let darkAt = 0;
    proxy = await startProxy(
      live.baseUrl,
      (req) =>
        dark && req.url.endsWith('/chat/completions')
          ? {
              kind: 'respond',
              status: 503,
              body: JSON.stringify({
                code: 'service_unavailable',
                message: 'outage',
                error_id: 'acc5',
              }),
            }
          : { kind: 'forward' },
      PROXY_PORT,
    );
    const base = `${PROXIED_APP}/api/nemodots`;
    const h = await api('GET', '/health', undefined, base);
    expect(h.status).toBe(200);
    expect(h.json.mode).toBe('live');
    expect(h.json.provider.host).toBe(proxy.host);
    const created = await api(
      'POST',
      '/missions',
      { goal: 'Keep the checkout service healthy.', mode: 'live' },
      base,
    );
    expect([200, 201]).toContain(created.status);
    const id = created.json.id ?? created.json.mission?.id;
    await api('POST', `/missions/${id}/start`, {}, base);
    // let the planner reach the provider once, then take the provider down
    const t0 = Date.now();
    while (
      !proxy.seen.some((x) => x.url.endsWith('/chat/completions')) &&
      Date.now() - t0 < 60_000
    )
      await new Promise((r) => setTimeout(r, 100));
    dark = true;
    darkAt = Date.now();

    const deadline = Date.now() + 4 * 60_000;
    let status = '';
    while (Date.now() < deadline) {
      const m = await api('GET', `/missions/${id}`, undefined, base);
      status = m.json?.mission?.status ?? m.json?.status ?? '';
      if (['blocked_provider', 'succeeded', 'failed'].includes(status)) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(
      status,
      'outage must block the mission, not complete or fail it',
    ).toBe('blocked_provider');
    const evs = await readEvents(id, 4000, base);
    const recorded = evs
      .filter((e) => kindOf(e) === 'model_call.recorded')
      .map(bodyOf);
    for (const c of recorded) {
      expect(c.provider.host).toBe(proxy.host);
      expect(c.provider.mode).toBe('live');
    }
    // no call reported completed after the outage began
    const post = (await loadReceipts(id, base)).records.filter(
      (x) => Date.parse(x.createdAt) > darkAt && x.outcome === 'completed',
    );
    expect(post).toEqual([]);
    // only the one configured host was ever contacted (the proxy saw every request)
    const h2 = await api('GET', '/health', undefined, base);
    expect(h2.json.mode).not.toBe('fixture');
    assertNoSecret(JSON.stringify(evs), live.apiKey);
  }, 420_000);
});
