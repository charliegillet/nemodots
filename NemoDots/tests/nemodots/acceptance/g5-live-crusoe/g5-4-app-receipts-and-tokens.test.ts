// TEST_PROMPT gate 5 cases 3, 4 (unused paths) and 8, driven through the
// running NemoDots app over its documented HTTP routes (contracts/routes.ts,
// prefix /api/nemodots). The app must be listening on the acc5 app port
// (NEMODOTS_ACC5_APP_URL, default http://127.0.0.1:4701). If it is not, these
// cases FAIL with "entry point missing: app not reachable"; they are never
// skipped.
//
//  G5.3 redacted request receipts for planner, specialist(worker), verifier
//       reasoning and changed-evidence replanning, all on Crusoe/Nemotron
//  G5.5 unused voice / Learning / research / connector inference paths are
//       disabled (configuration the app boots with)
//  G5.8 inference tokens and monitoring tokens are separate
//
// Expected values come from TEST_PROMPT gate 5 and ACCEPTANCE_CONTRACT 4.3.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_HOST,
  PRIMARY_MODEL,
  appEnv,
  assertNoSecret,
  requireLive,
  type LiveEnv,
} from './support.js';

const APP = (
  process.env.NEMODOTS_ACC5_APP_URL ?? 'http://127.0.0.1:4701'
).replace(/\/+$/, '');
const API = `${APP}/api/nemodots`;

let live: LiveEnv;

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      `ENTRY POINT MISSING: NemoDots app not reachable at ${APP} (${(error as Error).message.slice(0, 100)}). Start it on the acc5 port block (app 4701, checkout 4700) before running Gate 5 app cases.`,
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
async function readEvents(missionId: string, ms: number): Promise<Ev[]> {
  const out: Ev[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${API}/missions/${missionId}/events`, {
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
        env.WEB_SEARCH_PROVIDER === 'disabled' || empty('PARALLEL_API_KEY'),
        `WEB_SEARCH_PROVIDER is "${env.WEB_SEARCH_PROVIDER}" (expected disabled)`,
      )
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
        empty('COMPUTER_SUPERVISOR_URL') && empty('COMPUTER_TOKEN'),
        'computer service configured',
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
});

describe('G5.3 + G5.8 a live mission: redacted per-role receipts on Crusoe/Nemotron and separate token accounting', () => {
  let missionId = '';
  let events: Ev[] = [];
  let calls: Record<string, any>[] = [];

  it('G5.3a run a neutral-goal mission with a mid-run dependent change and collect its model-call receipts', async () => {
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
    calls = events
      .filter((e) => kindOf(e) === 'model_call.recorded')
      .map(bodyOf);
    expect(calls.length).toBeGreaterThan(0);
  }, 700_000);

  it('G5.3b every receipt is live, on the configured Crusoe host, requested == returned == the primary Nemotron model, and carries no secret', () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.provider).toEqual({ host: EXPECTED_HOST, mode: 'live' });
      expect(c.model.requested).toBe(PRIMARY_MODEL);
      if (c.outcome !== 'failed' && c.outcome !== 'aborted')
        expect(c.model.returned).toBe(c.model.requested);
      expect(c.prefixDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(c.contextDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(c.attempts).toBeGreaterThanOrEqual(1);
    }
    assertNoSecret(events, live.apiKey);
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/);
    expect(text).not.toMatch(/postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/prompt"\s*:/); // receipts are redacted: no raw prompt text
  });

  it('G5.3c the roles named by TEST_PROMPT all appear: planner, worker (specialist/verifier reasoning) and replan after the evidence changed', () => {
    const roles = new Set(calls.map((c) => c.role));
    expect(roles.has('planner'), 'planner call missing').toBe(true);
    expect(roles.has('worker'), 'specialist/verifier worker call missing').toBe(
      true,
    );
    expect(
      roles.has('replan'),
      'changed-evidence replanning call missing',
    ).toBe(true);
    // the replan happened after an invalidation was recorded
    const firstInvalidation = events.findIndex(
      (e) => kindOf(e) === 'invalidation.recorded',
    );
    const firstReplan = events.findIndex(
      (e) => kindOf(e) === 'model_call.recorded' && bodyOf(e).role === 'replan',
    );
    expect(firstInvalidation).toBeGreaterThanOrEqual(0);
    expect(firstReplan).toBeGreaterThan(firstInvalidation);
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
    const digests = new Set(calls.map((c) => c.prefixDigest));
    expect(groups.length).toBe(digests.size);
    // the stable-prefix claim only means something if groups actually repeat
    expect(
      groups.some((g) => g.calls >= 2),
      'no prefix digest was ever reused',
    ).toBe(true);
  });

  it('G5.8a telemetry token totals are exactly the sum of the inference receipts (aggregate provider metrics are not used as per-mission spans)', async () => {
    const t = await api('GET', `/missions/${missionId}/telemetry`);
    const sum = (k: string) => calls.reduce((n, c) => n + (c.usage[k] ?? 0), 0);
    expect(t.json.calls).toBe(calls.length);
    expect(t.json.tokens.prompt).toBe(sum('promptTokens'));
    expect(t.json.tokens.completion).toBe(sum('completionTokens'));
    const anyCached = calls.some((c) => c.usage.cachedTokens !== null);
    expect(t.json.tokens.cached.available).toBe(anyCached);
    if (anyCached) expect(t.json.tokens.cached.total).toBe(sum('cachedTokens'));
    else expect(t.json.tokens.cached.total).toBeNull();
    if (t.json.ttftMs !== null) {
      expect(t.json.ttftMs.p50).toBeGreaterThanOrEqual(0);
      expect(t.json.ttftMs.p95).toBeGreaterThanOrEqual(t.json.ttftMs.p50);
    }
  });

  it('G5.8b monitoring traffic (health checks and model-availability probes) adds no tokens to the inference totals', async () => {
    const before = (await api('GET', '/telemetry/summary')).json;
    for (let i = 0; i < 3; i++) {
      const h = await api('GET', '/health');
      expect(h.status).toBe(200);
    }
    await api('GET', '/sandbox/checkout/health');
    const after = (await api('GET', '/telemetry/summary')).json;
    expect(after.calls).toBe(before.calls);
    expect(after.tokens.prompt).toBe(before.tokens.prompt);
    expect(after.tokens.completion).toBe(before.tokens.completion);
    expect(after.tokens.cached).toEqual(before.tokens.cached);
  }, 60_000);
});
