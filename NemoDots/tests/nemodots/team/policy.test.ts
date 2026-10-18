// Team runtime policies: one behaviour everywhere. The product default is ON
// for pre-change verification; the live suite uses it with no override.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeTeamPolicy,
  incidentTeamConfig,
  requireVerifierEnabled,
} from '../../../src/server/nemodots/team/index.js';
import { liveTeamConfig } from '../live/team/config.js';
import {
  calls,
  claimed,
  digestToUuid,
  rig,
  runHandler,
  text,
  toolResultsOf,
  uuid,
} from './harness.js';

const KEY = 'cache.schema_version';
const SOURCE = `checkout.config/${KEY}`;
const config = { key: KEY, value: 4, version: 3 };
const receiptId = digestToUuid(`${SOURCE}:1:${JSON.stringify(config)}`);

const propose = (id: string) =>
  calls({
    id,
    name: 'propose_action',
    args: {
      action: 'set_config',
      payload: {
        key: KEY,
        value: 1,
        expectedCurrentValueDigest: '0'.repeat(64),
      },
      supportingReceiptIds: [receiptId],
      rationale: 'restore the schema the stored entries carry',
    },
  });
const observe = calls({
  id: 'o',
  name: 'observe_source',
  args: { sourceKey: SOURCE },
});

/** A rig with the production incident config (the one function bootstrap uses). */
function productRig(steps: Parameters<typeof rig>[0]) {
  const r = rig(steps);
  r.deps.config = {
    ...incidentTeamConfig(
      { model: r.deps.config.model, provider: r.deps.config.provider },
      { waitPollMs: 1, waitTimeoutMs: 200 },
    ),
  };
  r.observer.values.set(SOURCE, config);
  return r;
}

describe('pre-change verification (requireVerifier)', () => {
  it('the library default is off; the incident config is the single source that turns it on', () => {
    expect(requireVerifierEnabled({})).toBe(false);
    expect(requireVerifierEnabled({ requireVerifier: false })).toBe(false);
    const incident = incidentTeamConfig({
      model: 'm',
      provider: { host: 'h', mode: 'live' },
    });
    expect(incident.requireVerifier).toBe(true);
    expect(requireVerifierEnabled(incident)).toBe(true);
    const policy = describeTeamPolicy(incident);
    expect(policy.preChangeVerification).toBe(true);
    expect(policy.planRules.join(' ')).toContain('specialist');
    expect(policy.tokenBudget).toContain('input + output');
    expect(describeTeamPolicy({}).preChangeVerification).toBe(false);
    // the policy cannot be weakened through the function
    expect(
      incidentTeamConfig(
        { model: 'm', provider: { host: 'h', mode: 'live' } },
        { requireVerifier: false } as never,
      ).requireVerifier,
    ).toBe(true);
  });

  it('the live suite uses exactly the production incident config', () => {
    const model = 'nvidia/some-model';
    expect(liveTeamConfig(model, 'api.example.test')).toEqual(
      incidentTeamConfig({
        model,
        provider: { host: 'api.example.test', mode: 'live' },
      }),
    );
    expect(liveTeamConfig(model, 'h').requireVerifier).toBe(true);
  });

  it('refuses a specialist proposal until a delegated verifier finished, then admits it', async () => {
    const r = productRig([
      observe,
      propose('early'),
      calls({
        id: 'v',
        name: 'delegate_task',
        args: {
          title: 'Confirm',
          role: 'verifier',
          question: 'confirm the reading',
          dependsOn: [],
          justification: 'independent confirmation before a change',
        },
      }),
      propose('too-soon'),
      calls({ id: 'w', name: 'get_task_status', args: { taskId: uuid() } }),
      propose('late'),
      text('submitted'),
    ]);
    const delegate = r.coordinator.delegate.bind(r.coordinator);
    let verifierId = '';
    r.coordinator.delegate = async (c, i) => {
      const result = await delegate(c, i);
      verifierId = result.taskId;
      return result;
    };
    // the verifier finishes only after the second refusal
    const original = r.coordinator.getTaskStatus.bind(r.coordinator);
    let polls = 0;
    r.coordinator.getTaskStatus = async (m, t) => {
      polls += 1;
      if (verifierId && polls >= 3)
        r.coordinator.tasks.set(verifierId, {
          status: 'succeeded',
          role: 'verifier',
          title: 'Confirm',
        });
      else if (verifierId)
        r.coordinator.tasks.set(verifierId, {
          status: 'running',
          role: 'verifier',
          title: 'Confirm',
        });
      return original(m, t).catch(
        () =>
          ({
            task: { status: 'running', role: 'x', title: 'x' },
            outputUsable: null,
          }) as never,
      );
    };
    await runHandler(r, claimed('cache_specialist'));
    const results = toolResultsOf(r.inference.requests.at(-1)!);
    const byId = (id: string) => results.find((x) => x.id === id)!.body;
    expect(byId('early')).toMatchObject({
      ok: false,
      error: 'verification_required',
    });
    expect(byId('too-soon')).toMatchObject({
      ok: false,
      error: 'verification_required',
    });
    expect(byId('late')).toMatchObject({ ok: true });
    expect(r.actions.proposals).toHaveLength(1);
    expect(r.actions.proposals[0].ctx).toMatchObject({ toolCallId: 'late' });
  });

  it('a specialist that may not delegate gets verification_unavailable, not a dead end it cannot understand', async () => {
    const r = productRig([observe, propose('p'), text('stuck')]);
    await runHandler(
      r,
      claimed('cache_specialist', {
        capabilities: ['observe', 'publish_finding', 'propose_config_change'],
      }),
    );
    expect(toolResultsOf(r.inference.requests.at(-1)!)[1].body).toMatchObject({
      ok: false,
      error: 'verification_unavailable',
    });
    expect(r.actions.proposals).toHaveLength(0);
  });

  it('plan rule: a specialist task without delegate is corrected once under the default, accepted when the policy is off', async () => {
    const plan = (specialistCaps: string[]) =>
      JSON.stringify({
        tasks: [
          {
            title: 'a',
            question: 'q',
            role: 'investigator',
            capabilities: ['observe', 'delegate'],
            dependsOn: [],
          },
          {
            title: 'b',
            question: 'q',
            role: 'cache_specialist',
            capabilities: specialistCaps,
            dependsOn: [],
          },
        ],
      });
    const on = productRig([
      text(plan(['observe', 'propose_config_change'])),
      text(plan(['observe', 'delegate', 'propose_config_change'])),
    ]);
    on.observer.values.set('checkout.health', { status: 'ok' });
    on.observer.values.set('checkout.config', {
      keys: [],
      collectionVersion: 1,
    });
    expect((await runHandler(on, claimed('planner'))).type).toBe('plan');
    expect(on.inference.requests[1].messages.at(-1)!.content).toContain(
      'specialist and its capabilities must include delegate',
    );

    // the library default (policy off) accepts it
    const off = rig([text(plan(['observe', 'propose_config_change']))]);
    off.observer.values.set('checkout.health', { status: 'ok' });
    off.observer.values.set('checkout.config', {
      keys: [],
      collectionVersion: 1,
    });
    expect((await runHandler(off, claimed('planner'))).type).toBe('plan');
    expect(off.inference.requests).toHaveLength(1);
  });

  it('there is no live-only switch: the live suite never mentions the flag and uses liveTeamConfig', () => {
    const live = join(__dirname, '../live/team');
    for (const file of readdirSync(live))
      expect(readFileSync(join(live, file), 'utf8'), file).not.toMatch(
        /requireVerifier/,
      );
    expect(readFileSync(join(live, 'team.test.ts'), 'utf8')).toContain(
      'liveTeamConfig(',
    );
    expect(readFileSync(join(live, 'config.ts'), 'utf8')).toContain(
      'incidentTeamConfig(',
    );
  });
});

describe('context layout (evaluation 2x2)', () => {
  const plan = JSON.stringify({
    tasks: [
      {
        title: 'a',
        question: 'q',
        role: 'investigator',
        capabilities: ['observe', 'delegate'],
        dependsOn: [],
      },
      {
        title: 'b',
        question: 'q',
        role: 'investigator',
        capabilities: ['observe', 'delegate'],
        dependsOn: [],
      },
    ],
  });

  it('defaults to cache_aware for the worker loop and the planner', async () => {
    const worker = productRig([
      text('done'),
      text('{"defectFound":false,"area":"none","reason":"x"}'),
    ]);
    await runHandler(worker, claimed('investigator'));
    expect(worker.coordinator.modelCalls.map((c) => c.snapshot.layout)).toEqual(
      ['cache_aware', 'cache_aware'],
    );

    const planner = productRig([text(plan)]);
    planner.observer.values.set('checkout.health', { status: 'ok' });
    planner.observer.values.set('checkout.config', {
      keys: [],
      collectionVersion: 1,
    });
    await runHandler(planner, claimed('planner'));
    expect(planner.coordinator.modelCalls[0].snapshot.layout).toBe(
      'cache_aware',
    );
  });

  it('TeamConfig.layout reaches every compiled call: planner, worker turns and the closing check', async () => {
    const worker = productRig([
      calls({ id: 'o', name: 'observe_source', args: { sourceKey: SOURCE } }),
      text('done'),
      text('{"defectFound":false,"area":"none","reason":"x"}'),
    ]);
    worker.deps.config.layout = 'ordinary';
    await runHandler(worker, claimed('investigator'));
    expect(worker.coordinator.modelCalls).toHaveLength(3);
    for (const call of worker.coordinator.modelCalls)
      expect(call.snapshot.layout).toBe('ordinary');
    // the ordinary layout really is the other arrangement: the time comes first
    expect(worker.inference.requests[0].messages[0].content).toMatch(
      /^## Current time/,
    );

    const planner = productRig([text(plan)]);
    planner.deps.config.layout = 'ordinary';
    planner.observer.values.set('checkout.health', { status: 'ok' });
    planner.observer.values.set('checkout.config', {
      keys: [],
      collectionVersion: 1,
    });
    await runHandler(planner, claimed('planner'));
    expect(planner.coordinator.modelCalls[0].snapshot.layout).toBe('ordinary');
  });

  it('the incident config does not choose a layout', () => {
    expect(
      incidentTeamConfig({ model: 'm', provider: { host: 'h', mode: 'live' } })
        .layout,
    ).toBeUndefined();
  });
});
