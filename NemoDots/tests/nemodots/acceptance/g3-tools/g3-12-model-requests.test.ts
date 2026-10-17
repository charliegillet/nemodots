/* eslint-disable @typescript-eslint/no-explicit-any -- OpenAI wire payloads are untyped JSON */
// Gate 3, TOOL_COVERAGE section 5 and TEST_PROMPT gate 3 ("the incident adapter/route"): what the NemoDots planner
// and workers actually SEND to the model. The check is on the wire, stronger than a recording InferencePort: the
// verifier's scripted provider (g4-autonomy/provider.ts) receives the real adapter's HTTP request.
//
//   planner  -> no tools at all, no tool_choice;
//   worker   -> exactly the nine documented team tools, in the documented order, no tool_choice "required";
//   both     -> the request carries no credential value (database URLs, API keys, probe secret, owner token).
//
// The scripted provider answers the planner with a valid 2-task plan and every worker with plain text; the mission is
// cancelled as soon as one worker request was observed. This proves request shape, never model behaviour.
// Ports (g4 block, sequential files): checkout 4680, app 4681, provider 4683. Entry points missing -> ENTRY POINT MISSING.
import { afterAll, describe, expect, it } from 'vitest';
import { G4 } from '../g4-autonomy/config.js';
import { NemoApi } from '../g4-autonomy/api.js';
import { startProvider, type Provider } from '../g4-autonomy/provider.js';
import { startSystem, waitFor, type System } from '../g4-autonomy/system.js';
import { secretsPresentIn, visibleSecrets } from './g3-support.js';

// Hand copy of TOOL_COVERAGE section 1, in the documented order.
const DOCUMENTED_TOOLS = [
  'observe_source',
  'list_runbooks',
  'read_runbook',
  'delegate_task',
  'get_task_status',
  'wait_for_children',
  'publish_finding',
  'propose_action',
  'request_replan',
];

const PLAN = {
  tasks: [
    {
      title: 'Inspect health',
      question: 'What does the health endpoint report?',
      role: 'investigator',
      capabilities: ['observe', 'delegate', 'publish_finding', 'request_replan'],
      dependsOn: [],
    },
    {
      title: 'Inspect configuration',
      question: 'Which configuration members exist?',
      role: 'investigator',
      capabilities: ['observe', 'delegate', 'publish_finding', 'request_replan'],
      dependsOn: [],
    },
  ],
};

let memo: Promise<{ provider: Provider; system: System; api: NemoApi }> | null = null;
async function boot() {
  const provider = await startProvider({
    port: G4.providerPort,
    model: 'acc3-wire-model',
    script: (call) =>
      call.kind === 'structured'
        ? { type: 'content', text: JSON.stringify(PLAN) }
        : { type: 'content', text: 'Nothing further to report.' },
  });
  try {
    const system = await startSystem({
      providerUrl: provider.url,
      providerModel: 'acc3-wire-model',
    });
    return { provider, system, api: new NemoApi(system.baseUrl) };
  } catch (error) {
    await provider.close().catch(() => undefined);
    throw error;
  }
}
const started = () => (memo ??= boot());
afterAll(async () => {
  if (!memo) return;
  const s = await memo.catch(() => null);
  if (!s) return;
  await s.system.stop().catch(() => undefined);
  await s.provider.close().catch(() => undefined);
}, 180_000);

const toolNamesOf = (body: any): string[] =>
  (body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name ?? '');

describe('[TP3.3][TP3.4][TP3.7] the requests the NemoDots planner and workers send', () => {
  it('the planner sends no tools and no tool_choice; a worker sends exactly the nine team tools and never tool_choice "required"; no request carries a credential value', async () => {
    const { provider, api } = await started();
    const mission = await api.createMission({
      goal: 'Investigate the checkout service and restore normal operation if anything is wrong.',
    });
    await api.lifecycle(mission.id, 'start');
    try {
      await waitFor(
        'a planner and a worker request',
        async () =>
          provider.calls.some((c) => c.kind === 'structured') &&
          provider.calls.some((c) => c.kind === 'worker'),
        180_000,
        500,
      );
    } finally {
      await api.lifecycle(mission.id, 'cancel', [200, 409]).catch(() => undefined);
    }

    const planner = provider.calls.filter((c) => c.kind === 'structured');
    const workers = provider.calls.filter((c) => c.kind === 'worker');
    expect(planner.length).toBeGreaterThanOrEqual(1);
    expect(workers.length).toBeGreaterThanOrEqual(1);

    for (const call of planner) {
      expect(toolNamesOf(call.body), 'planner tools').toEqual([]);
      expect(call.body.tool_choice, 'planner tool_choice').toBeUndefined();
    }
    for (const call of workers) {
      expect(toolNamesOf(call.body), 'worker tools').toEqual(DOCUMENTED_TOOLS);
      expect(call.body.tool_choice).not.toBe('required');
      expect(JSON.stringify(call.body.tool_choice ?? '')).not.toContain('required');
    }
    const secrets = visibleSecrets();
    expect(secrets.length, 'the verifier can see secrets to look for').toBeGreaterThan(0);
    for (const call of provider.calls)
      expect(
        secretsPresentIn(JSON.stringify(call.body), secrets),
        `request #${call.n} carries credentials`,
      ).toEqual([]);
  }, 400_000);
});
