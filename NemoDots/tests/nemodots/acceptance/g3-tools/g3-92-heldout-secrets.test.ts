// Gate 3 HELD-OUT cases for TP3.7 (Crusoe keys and Intelligence secrets are server-side only),
// added 2026-10-18 after the independence disclosure (./README.md). Fresh random canary
// secrets are placed where the real ones live (the server environment the composition is
// built from, and the Dot agent's provider configuration). No route a client can call, no
// Dot-turn event and no model-visible content may carry them. Values are never printed:
// a failure names the place, not the secret.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openWorld, runDotTurn, type World } from './g3-support.js';

const canary = (label: string) => `${label}-${randomBytes(16).toString('hex')}`;
const SECRETS = {
  OPENAI_API_KEY: canary('ok'),
  CPK_INTELLIGENCE_API_KEY: canary('ik'),
};
const AGENT = { apiKey: canary('ak'), intelligenceKey: canary('ai') };
const saved: Record<string, string | undefined> = {};
let w: World;

/** Names of the canaries contained in `text` (never the values). */
const leaked = (text: string) =>
  Object.entries({ ...SECRETS, ...AGENT })
    .filter(([, value]) => text.includes(value))
    .map(([name]) => name);

beforeAll(async () => {
  for (const [name, value] of Object.entries(SECRETS)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  w = await openWorld({ nemodots: true });
  w.agentConfig = {
    ...w.agentConfig,
    ...AGENT,
    model: 'acc3-model',
    baseUrl: 'https://model.acc3.invalid/v1',
  };
}, 600_000);
afterAll(async () => {
  await w?.close();
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}, 120_000);

describe('[HELD-OUT] [TP3.7] random canary secrets stay server-side', () => {
  it('[TP3.7] held-out: control: the canaries are really in the server environment and the agent configuration (a clean result is meaningful)', () => {
    for (const [name, value] of Object.entries(SECRETS))
      expect(process.env[name] === value, name).toBe(true);
    expect(leaked(JSON.stringify(w.agentConfig)).sort()).toEqual(
      Object.keys(AGENT).sort(),
    );
  });

  it('[TP3.7] held-out: no owner route a client can call returns a canary (state, settings, tasks, NemoDots health, missions, telemetry)', async () => {
    const routes: [string, RequestInit?][] = [
      ['/api/state'],
      ['/api/tasks'],
      ['/api/nemodots/health'],
      ['/api/nemodots/missions'],
      ['/api/nemodots/telemetry/summary'],
      ['/api/settings', { method: 'PATCH', body: JSON.stringify({}) }],
    ];
    let reached = 0;
    for (const [path, init] of routes) {
      const res = await w.authed(path, init);
      if (res.status < 400) reached += 1;
      const text = await res.text();
      expect(leaked(text), `${path} (${res.status})`).toEqual([]);
      expect(
        leaked(JSON.stringify(Object.fromEntries(res.headers))),
        `${path} headers`,
      ).toEqual([]);
    }
    expect(reached, 'control: some routes answered').toBeGreaterThan(0);
  });

  it('[TP3.7] held-out: a Dot turn exposes no canary in its events, in any model request body or in any tool result', async () => {
    const page = w.workspace.pages.create(w.spaceA, {
      title: `p${randomBytes(3).toString('hex')}`,
      content: 'evidence',
    });
    for (const dotId of [w.incident.id, w.normal.id]) {
      const turn = await runDotTurn(w, dotId, [
        {
          toolCalls: [
            { id: 'r1', name: 'read_space_page', arguments: { id: page.id } },
            { id: 'r2', name: 'list_authorized_spaces', arguments: {} },
          ],
        },
        { text: 'done' },
      ]);
      expect(
        turn.requests.length,
        'control: the model was called',
      ).toBeGreaterThan(0);
      expect(leaked(JSON.stringify(turn.events)), `${dotId} events`).toEqual(
        [],
      );
      for (const request of turn.requests)
        expect(
          leaked(JSON.stringify(request.body) + request.url),
          `${dotId} model request`,
        ).toEqual([]);
      for (const id of ['r1', 'r2'])
        expect(leaked(turn.resultOf(id) ?? ''), `${dotId} ${id}`).toEqual([]);
    }
  });
});
