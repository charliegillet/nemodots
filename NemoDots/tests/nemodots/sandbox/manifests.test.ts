// The development scenario set: every manifest parses, covers the documented
// classes, resolves deterministically per seed, and the sandbox keeps its
// isolation rules (no ledger/coordinator/inference/team imports, no frozen set).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ScenarioManifestSchema,
  defaultScenarioDir,
  listScenarios,
  loadScenario,
  parseManifest,
  resolveScenario,
  seededRandom,
} from '../../../src/server/nemodots/sandbox/manifest.js';
import { validateConfigValue } from '../../../src/server/nemodots/sandbox/config-schema.js';

const REQUIRED = [
  'healthy',
  'benign_change',
  'cache_schema_mismatch',
  'pool_starvation',
  'stale_replica',
  'writes_disabled',
  'dependent_change_after_proposal',
  'second_change_during_repair',
  'conflicting_observations',
  'diverging_edges',
];

describe('scenario manifests', () => {
  it('ships every required scenario in the development set', () => {
    expect(listScenarios()).toEqual([...REQUIRED].sort());
  });

  it.each(REQUIRED)(
    '%s parses, matches its file name and injects legal values',
    (id) => {
      const manifest = loadScenario(id);
      expect(manifest.id).toBe(id);
      for (const seed of [0, 1, 2, 99]) {
        const steps = resolveScenario(manifest, seed);
        expect(steps).toHaveLength(manifest.steps.length);
        for (const step of steps) {
          if (step.kind === 'delete_config') continue;
          if (step.values)
            for (const [key, value] of Object.entries(step.values))
              expect(validateConfigValue(key, value).ok).toBe(true);
          else expect(validateConfigValue(step.key!, step.value).ok).toBe(true);
        }
      }
    },
  );

  it('resolution is deterministic for a seed', () => {
    for (const id of REQUIRED) {
      const manifest = loadScenario(id);
      expect(resolveScenario(manifest, 5)).toEqual(
        resolveScenario(manifest, 5),
      );
    }
    const a = seededRandom(1, 'x');
    const b = seededRandom(1, 'x');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seededRandom(1, 'x')()).not.toBe(seededRandom(2, 'x')());
  });

  it('control and benign scenarios require no repair; every fault scenario does', () => {
    for (const id of REQUIRED) {
      const { oracle } = loadScenario(id);
      const control = id === 'healthy' || id === 'benign_change';
      expect(oracle.expectation).toBe(
        control ? 'no_action_required' : 'repair_required',
      );
      if (!control) expect(oracle.acceptableRepairs.length).toBeGreaterThan(0);
    }
  });

  it('the dependent-change scenario carries a LISTEN-driven step after the fault', () => {
    const m = loadScenario('dependent_change_after_proposal');
    const steps = resolveScenario(m, 1);
    expect(steps[0].trigger).toBe('immediate');
    expect(steps[1]).toMatchObject({
      kind: 'dependent_change_after_proposal',
      trigger: 'on_action_proposed',
      after: [0],
    });
    expect(Object.keys(steps[1].values!)).toEqual(['cache.schema_version']);
  });

  it('the dependent step has no wall-clock limit of its own', () => {
    const m = loadScenario('dependent_change_after_proposal');
    expect(JSON.stringify(m.steps)).not.toContain('timeoutMs');
    expect(resolveScenario(m, 1)[1].timeoutMs).toBeNull();
    // an explicit bound is still expressible, and is the only way to get one
    const bounded = ScenarioManifestSchema.parse({
      ...m,
      steps: [m.steps[0], { ...m.steps[1], timeoutMs: 1_000 }],
    });
    expect(resolveScenario(bounded, 1)[1].timeoutMs).toBe(1_000);
  });

  it('marks the initial steps (no prerequisites, not proposal-triggered)', () => {
    const steps = resolveScenario(loadScenario('diverging_edges'), 1);
    expect(steps.map((st) => st.initial)).toEqual([true, true, false]);
    const dependent = resolveScenario(
      loadScenario('dependent_change_after_proposal'),
      1,
    );
    expect(dependent.map((st) => st.initial)).toEqual([true, false]);
  });

  it('every scenario declares what must be visible before a mission starts', () => {
    const faults: Record<string, string[]> = {
      healthy: ['healthy'],
      benign_change: ['healthy'],
      cache_schema_mismatch: ['cache_decode_error'],
      dependent_change_after_proposal: ['cache_decode_error'],
      second_change_during_repair: ['cache_decode_error'],
      pool_starvation: ['pool_exhausted'],
      stale_replica: ['inventory_inconsistent'],
      writes_disabled: ['writes_disabled'],
      conflicting_observations: ['healthy', 'inventory_inconsistent'],
      diverging_edges: ['cache_decode_error', 'inventory_inconsistent'],
    };
    for (const id of REQUIRED) {
      const declared = loadScenario(id).preconditions;
      expect(declared, id).toBeDefined();
      expect([...declared!.visible].sort(), id).toEqual([...faults[id]].sort());
    }
  });

  it('every scenario that bumps the cache schema warms the cache first', () => {
    for (const id of REQUIRED) {
      const m = loadScenario(id);
      const bumpsSchema = JSON.stringify(m.steps).includes(
        'cache.schema_version',
      );
      const warms = (m.preconditions?.setup ?? []).some(
        (a) => a.kind === 'warm_cache',
      );
      expect(warms, id).toBe(bumpsSchema);
    }
  });

  it('rejects unknown precondition kinds and symptoms', () => {
    const base = loadScenario('writes_disabled');
    for (const bad of [
      { visible: ['no_such_symptom'] },
      { visible: [] },
      { visible: ['healthy'], setup: [{ kind: 'drop_database' }] },
      { visible: ['healthy'], withinMs: 5 },
      { visible: ['healthy'], extra: true },
    ])
      expect(
        ScenarioManifestSchema.safeParse({ ...base, preconditions: bad })
          .success,
      ).toBe(false);
  });

  it('diverging_edges documents the independent reads of its two branches', () => {
    const { oracle, steps } = loadScenario('diverging_edges');
    expect(Object.keys(oracle.independentReads ?? {}).sort()).toEqual([
      'cache_branch',
      'routing_branch',
    ]);
    expect(steps).toHaveLength(3);
    // the late step touches only the cache branch's key
    expect(steps[2].key).toBe('cache.schema_version');
  });

  it('rejects ill-formed manifests', () => {
    const base = JSON.parse(
      readFileSync(
        path.join(defaultScenarioDir(), 'writes_disabled.json'),
        'utf8',
      ),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mutate = (fn: (m: Record<string, any>) => void) => {
      const copy = structuredClone(base);
      fn(copy);
      return ScenarioManifestSchema.safeParse(copy).success;
    };
    expect(mutate(() => {})).toBe(true);
    expect(mutate((m) => (m.steps[0].value = 'not-a-bool'))).toBe(false);
    expect(mutate((m) => (m.steps[0].key = 'orders.write_enabled '))).toBe(
      false,
    );
    expect(mutate((m) => delete m.steps[0].value)).toBe(false);
    expect(mutate((m) => (m.steps[0].after = [0]))).toBe(false);
    expect(mutate((m) => (m.steps[0].extra = 1))).toBe(false);
    expect(mutate((m) => (m.id = '../x'))).toBe(false);
    expect(mutate((m) => (m.steps[0].trigger = { type: 'delay' }))).toBe(false);
    expect(
      mutate((m) => {
        m.steps[0] = {
          kind: 'dependent_change_after_proposal',
          key: 'db.pool_max',
          value: 2,
        };
      }),
    ).toBe(false);
    expect(() => parseManifest('{')).toThrow();
  });

  it('loadScenario refuses path-like ids', () => {
    expect(() => loadScenario('../frozen/x')).toThrow(/invalid scenario id/);
    expect(() => loadScenario('a/b')).toThrow(/invalid scenario id/);
    expect(() => loadScenario('missing_one')).toThrow();
  });
});

describe('sandbox isolation rules', () => {
  const dir = path.resolve(process.cwd(), 'src/server/nemodots/sandbox');
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => [name, readFileSync(path.join(dir, name), 'utf8')] as const);

  it('imports nothing from ledger, coordinator, inference or team', () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const [name, text] of sources)
      expect(text, name).not.toMatch(
        /from '\.\.\/(ledger|coordinator|inference|team|actions|watcher|routes)\//,
      );
  });

  it('the injector never reads coordinator or ledger tables', () => {
    const injector = sources.find(([name]) => name === 'injector.ts')![1];
    expect(injector).not.toMatch(/coordinator\.|ledger\./);
    expect(injector).toContain('LISTEN');
  });

  it('only the version authority writes checkout.config_entries', () => {
    for (const [name, text] of sources) {
      if (name === 'version-authority.ts') continue;
      expect(text, name).not.toMatch(
        /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+checkout\.config_(entries|collection|versions)/i,
      );
    }
  });

  it('nothing reads the frozen scenario set', () => {
    for (const [name, text] of sources)
      expect(text, name).not.toMatch(/evals\/nemodots\/frozen|['"]frozen['"]/);
  });

  it('the checkout API never queries control.* and states no baseline value', () => {
    const app = sources
      .filter(([name]) => name.startsWith('checkout-'))
      .map(([, text]) => text)
      .join('\n');
    expect(app).not.toMatch(/control\./);
    expect(app).not.toMatch(/catalog-a|Free shipping/);
  });
});
