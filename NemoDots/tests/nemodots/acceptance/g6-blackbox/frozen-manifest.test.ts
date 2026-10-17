// G6.1/G6.2 static checks of the frozen held-out set and a case-map guard that
// every TEST_PROMPT gate-6 case has at least one named test in this suite.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigKeySchema } from '../../../../src/server/nemodots/contracts/index.js';
import {
  CONTROL_CLASSES,
  REPAIR_CLASSES,
  loadManifest,
  loadThresholds,
  loadTrials,
} from './helpers/frozen.js';

const manifest = loadManifest();
const trials = loadTrials();
const CLASSES = [
  'healthy_control',
  'benign_unrelated_change',
  'repairable_checkout_fault',
  'dependent_change_after_proposed_repair',
  'second_change_during_repair',
  'conflicting_observations',
  'provider_disruption',
  'worker_crash',
];

describe('G6.1 frozen scenario classes and held-out variations', () => {
  it('G6.1 all eight scenario classes are present with the manifest trial counts (28 total)', () => {
    expect(manifest.classes.map((c) => c.class)).toEqual(CLASSES);
    for (const entry of manifest.classes)
      expect(
        trials.filter((t) => t.cls === entry.class),
        entry.class,
      ).toHaveLength(entry.trials);
    expect(trials).toHaveLength(manifest.totalTrials);
    expect(trials).toHaveLength(28);
    for (const cls of [...REPAIR_CLASSES, ...CONTROL_CLASSES])
      expect(CLASSES).toContain(cls);
  });

  it('G6.1 trial ids and seeds are unique and every class has at least the minimum scored trials', () => {
    expect(new Set(trials.map((t) => t.trial.trialId)).size).toBe(
      trials.length,
    );
    expect(new Set(trials.map((t) => t.trial.seed)).size).toBe(trials.length);
    const min = loadThresholds().usefulness;
    expect(min.repairResolution.classes.length).toBe(5);
    for (const cls of CLASSES)
      expect(
        trials.filter((t) => t.cls === cls).length,
        cls,
      ).toBeGreaterThanOrEqual(3);
  });

  it('G6.1 repairable faults span F1-F5 with held-out values and timings', () => {
    const repairable = trials
      .filter((t) => t.cls === 'repairable_checkout_fault')
      .map((t) => t.trial);
    const faults = new Set(repairable.map((t) => t.faultClass));
    for (const f of ['F1', 'F2', 'F3', 'F4', 'F5'])
      expect(faults, f).toContain(f);
    const values = repairable.flatMap((t) =>
      t.steps.map((s) => JSON.stringify([s.key, s.value])),
    );
    expect(
      new Set(values).size,
      'injected values vary across trials',
    ).toBeGreaterThanOrEqual(5);
    expect(
      new Set(repairable.map((t) => t.probe.quantity)).size,
    ).toBeGreaterThan(1);
  });

  it('G6.1 every step uses a known configuration key, a known trigger and a known actor', () => {
    const keys = new Set<string>(ConfigKeySchema.options);
    const triggers = new Set([
      'pre_start',
      'at_ms',
      'on_action_proposed',
      'after_first_commit',
      'after_first_admitted',
    ]);
    for (const { trial } of trials)
      for (const step of trial.steps) {
        expect(keys.has(step.key), `${trial.trialId} key ${step.key}`).toBe(
          true,
        );
        expect(
          triggers.has(step.trigger.kind),
          `${trial.trialId} trigger`,
        ).toBe(true);
        expect(['injector', 'owner']).toContain(step.actor);
      }
  });

  it('G6.1 non-control trials declare allowed mutation keys; control trials declare no fault', () => {
    for (const { cls, trial } of trials) {
      if (cls === 'healthy_control') expect(trial.steps).toEqual([]);
      else if (cls === 'benign_unrelated_change')
        expect(
          trial.steps.every(
            (s) => s.key === 'ui.banner_text' && s.actor === 'owner',
          ),
        ).toBe(true);
      else {
        expect(trial.expected, trial.trialId).toBeDefined();
        expect(trial.expected!.allowedMutationKeys.length).toBeGreaterThan(0);
      }
      if (cls === 'provider_disruption')
        expect(trial.disruption, trial.trialId).toBeDefined();
      if (cls === 'worker_crash')
        expect(trial.crash, trial.trialId).toBeDefined();
    }
  });
});

describe('G6.2 the runtime only ever receives a neutral goal', () => {
  it('G6.2 goal and constraints name no key, value, fault, class or trial', () => {
    const text = [manifest.missionGoal, ...manifest.missionConstraints]
      .join('\n')
      .toLowerCase();
    const forbidden = new Set<string>(
      ConfigKeySchema.options.flatMap((k) => [k, k.split('.')[1]]),
    );
    for (const { cls, trial } of trials) {
      forbidden.add(trial.trialId);
      forbidden.add(cls);
      if (trial.faultClass) forbidden.add(trial.faultClass);
      for (const step of trial.steps)
        if (typeof step.value === 'string') forbidden.add(step.value);
    }
    for (const word of [
      'fault',
      'namespace',
      'schema',
      'replica',
      'pool',
      'redis',
      'cache',
      'maintenance',
      'injector',
      'scenario',
    ])
      forbidden.add(word);
    for (const token of forbidden)
      expect(text, `goal mentions "${token}"`).not.toContain(
        token.toLowerCase(),
      );
  });

  it('G6.2 the mission goal is within the public contract limits', () => {
    expect(manifest.missionGoal.length).toBeGreaterThan(0);
    expect(manifest.missionGoal.length).toBeLessThanOrEqual(2000);
    expect(manifest.missionConstraints.length).toBeLessThanOrEqual(20);
  });
});

describe('G6.0 case map', () => {
  it('G6.0 every gate-6 case G6.1 to G6.10 has at least one named test in this suite', () => {
    const dir = __dirnameOf();
    const titles = readdirSync(dir)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => readFileSync(resolve(dir, f), 'utf8'))
      .join('\n');
    for (let n = 1; n <= 10; n += 1)
      expect(new RegExp(`G6\\.${n}(?!\\d)`).test(titles), `case G6.${n}`).toBe(
        true,
      );
  });
});

function __dirnameOf() {
  return new URL('.', import.meta.url).pathname;
}
