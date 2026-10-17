// Cross-checks the hand-enumerated oracle against an independent reference
// traversal written here (not production code). A disagreement is an oracle
// bug and must be fixed through a reviewed revision, never by editing the
// production expectation silently.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLOSURE_CASES,
  REJECTION_CASES,
  SELF_WRITE_CASES,
} from '../oracle/closures.js';
import { LEDGER_CASES } from '../oracle/ledger.js';
import {
  ADMISSION_CASES,
  LEASE_CASES,
  SETUP_CONFIG,
  type AdmissionOutcome,
} from '../oracle/admission.js';
import { CHECKOUT_INVARIANTS } from '../oracle/checkout-invariants.js';
import {
  BLOCK_REASON,
  CLOSURE_DEPTH_CAP,
  CLOSURE_NODE_CAP,
  CONFIG_DOMAIN,
  CONFIG_KEYS,
  type ConfigKey,
  type ConfigValue,
} from '../oracle/spec-enums.js';
import type { AffectedSets, ClosureCase, GraphEdge } from '../oracle/types.js';
import { APP_ROOT } from '../driver/entry-points.js';

function reach(edges: readonly GraphEdge[], roots: readonly string[]) {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind === 'scheduling') continue;
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const next = queue.shift() as string;
    for (const to of out.get(next) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

function referenceClosure(c: ClosureCase, missionId?: string): AffectedSets {
  const reached = reach(
    c.edges,
    c.changes.map((change) => change.oldReceipt),
  );
  const nodes = c.nodes.filter(
    (n) =>
      reached.has(n.id) &&
      (missionId === undefined || n.missionId === missionId),
  );
  const ids = (kind: string) =>
    nodes
      .filter((n) => n.kind === kind)
      .map((n) => n.id)
      .sort();
  const attempts = nodes.filter((n) => n.kind === 'attempt');
  const taskIds = [...new Set(attempts.map((n) => n.taskId as string))].sort();
  return {
    modelCallIds: ids('model_call'),
    attemptIds: ids('attempt'),
    outputIds: ids('task_output'),
    actionIds: ids('action_intent'),
    taskIds,
  };
}

const sortSets = (s: AffectedSets): AffectedSets => ({
  modelCallIds: [...s.modelCallIds].sort(),
  attemptIds: [...s.attemptIds].sort(),
  outputIds: [...s.outputIds].sort(),
  actionIds: [...s.actionIds].sort(),
  taskIds: [...s.taskIds].sort(),
});

function hasCycle(adjacency: Map<string, string[]>): boolean {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (node: string): boolean => {
    const s = state.get(node);
    if (s === 'visiting') return true;
    if (s === 'done') return false;
    state.set(node, 'visiting');
    for (const next of adjacency.get(node) ?? []) if (visit(next)) return true;
    state.set(node, 'done');
    return false;
  };
  return [...adjacency.keys()].some((node) => visit(node));
}

describe('closure oracle agrees with an independent reference traversal', () => {
  it.each(CLOSURE_CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const ids = new Set(c.nodes.map((n) => n.id));
    expect(ids.size, 'node ids unique').toBe(c.nodes.length);
    for (const edge of c.edges) {
      expect(
        ids.has(edge.from) && ids.has(edge.to),
        `edge ${edge.from}->${edge.to}`,
      ).toBe(true);
      if (edge.kind === 'scheduling') continue;
      const from = c.nodes.find((n) => n.id === edge.from);
      const to = c.nodes.find((n) => n.id === edge.to);
      expect(
        (from?.seq ?? 0) < (to?.seq ?? 0),
        `older->newer ${edge.from}->${edge.to}`,
      ).toBe(true);
    }
    for (const change of c.changes)
      expect(c.nodes.find((n) => n.id === change.oldReceipt)?.kind).toBe(
        'receipt',
      );

    expect(sortSets(c.expected.affected)).toEqual(referenceClosure(c));

    const missions = [
      ...new Set(
        c.nodes.filter((n) => n.kind === 'task').map((n) => n.missionId),
      ),
    ];
    const withEvents = missions.filter(
      (mission) => referenceClosure(c, mission).attemptIds.length > 0,
    );
    expect(c.expected.perMission.map((p) => p.missionId).sort()).toEqual(
      withEvents.sort(),
    );
    for (const p of c.expected.perMission) {
      const ref = referenceClosure(c, p.missionId);
      expect(sortSets(p.affected), `perMission ${p.missionId}`).toEqual(ref);
      const tasks = c.nodes
        .filter((n) => n.kind === 'task' && n.missionId === p.missionId)
        .map((n) => n.id);
      expect([...p.preservedTaskIds].sort()).toEqual(
        tasks.filter((task) => !ref.taskIds.includes(task)).sort(),
      );
    }

    const reached = reach(
      c.edges,
      c.changes.map((x) => x.oldReceipt),
    );
    for (const node of c.nodes.filter((n) => n.kind === 'action_intent')) {
      const after = c.expected.intentStatusAfter[node.id];
      if (!reached.has(node.id)) {
        if (after) expect(after.status).toBe(node.intentStatus);
        continue;
      }
      expect(after, `intent ${node.id} listed`).toBeDefined();
      if (node.intentStatus === 'proposed' || node.intentStatus === 'admitted')
        expect(after).toEqual({
          status: 'blocked',
          blockReason: 'stale_version',
        });
      else expect(after?.status).toBe(node.intentStatus);
    }

    expect(c.expected.invalidationEvents).toBe(c.changes.length);
    for (const receipt of c.expected.receiptsStillCurrent ?? []) {
      expect(c.changes.some((x) => x.oldReceipt === receipt)).toBe(false);
      expect(c.nodes.find((n) => n.id === receipt)?.kind).toBe('receipt');
    }

    if (c.expected.dagRestartTaskIds) {
      // DAG restart: rerun affected tasks plus all scheduling/parent descendants.
      const down = new Map<string, string[]>();
      for (const e of c.edges)
        if (e.kind === 'scheduling')
          down.set(e.from, [...(down.get(e.from) ?? []), e.to]);
      for (const n of c.nodes)
        if (n.kind === 'task' && n.parentTaskId)
          down.set(n.parentTaskId, [...(down.get(n.parentTaskId) ?? []), n.id]);
      const start = referenceClosure(c).taskIds;
      const rerun = new Set(start);
      const queue = [...start];
      while (queue.length)
        for (const next of down.get(queue.shift() as string) ?? [])
          if (!rerun.has(next)) {
            rerun.add(next);
            queue.push(next);
          }
      expect([...c.expected.dagRestartTaskIds].sort()).toEqual(
        [...rerun].sort(),
      );
    }
  });

  it('CL-3 is the only conservative case and is labelled so', () => {
    expect(
      CLOSURE_CASES.filter((c) => c.expected.conservative).map((c) => c.id),
    ).toEqual(['CL-3']);
  });

  it('at least one case preserves work that a DAG restart would rerun (D8)', () => {
    expect(
      CLOSURE_CASES.some(
        (c) =>
          (c.expected.dagRestartTaskIds?.length ?? 0) >
          c.expected.affected.taskIds.length,
      ),
    ).toBe(true);
  });
});

describe('rejection oracle', () => {
  it.each(REJECTION_CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const op = c.operation;
    if (op.kind === 'plan') {
      const adjacency = new Map<string, string[]>(
        op.dependsOn.map((deps, index) => [String(index), deps.map(String)]),
      );
      expect(hasCycle(adjacency)).toBe(true);
      expect(c.expected.acceptedCodes).toEqual(['scheduling_cycle']);
    } else if (op.kind === 'delegate') {
      // A waits on B; a child waits on its dependsOn; a parent waits on its child.
      const adjacency = new Map<string, string[]>();
      const add = (from: string, to: string) =>
        adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
      for (const task of op.existing)
        for (const w of task.waitsOn) add(task.id, w);
      add(op.parentTaskId, 'CHILD');
      for (const dep of op.childDependsOn) add('CHILD', dep);
      expect(hasCycle(adjacency)).toBe(true);
    } else if (op.kind === 'edge') {
      const from = op.nodes.find((n) => n.id === op.add.from);
      const to = op.nodes.find((n) => n.id === op.add.to);
      const createsCycle = reach([...op.existing], [op.add.to]).has(
        op.add.from,
      );
      expect(createsCycle || (from?.seq ?? 0) >= (to?.seq ?? 0)).toBe(true);
    } else {
      if (op.shape === 'chain')
        expect(op.size).toBeGreaterThan(CLOSURE_DEPTH_CAP);
      else expect(op.size).toBeGreaterThan(CLOSURE_NODE_CAP);
      expect(c.expected.afterwards?.recoveryKind).toBe(
        'mission_paused_closure_cap',
      );
    }
  });
});

describe('self-write oracle', () => {
  it.each(SELF_WRITE_CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const last = c.history[c.history.length - 1];
    const head =
      last.by === 'action'
        ? last.afterDigestMatches
          ? 'verified'
          : 'mismatch'
        : 'none';
    expect(c.expected.headSelfWrite).toBe(head);
    // Acting lineage is spared only when the LAST row is a verified self-write.
    expect(c.expected.actingLineageInvalidated).toBe(head !== 'verified');
    expect(c.expected.otherReadersInvalidated).toBe(true);
    expect(c.expected.postconditionAttempts).toBe(head === 'verified' ? 1 : 0);
    for (const row of c.history)
      if (row.by === 'action')
        expect(c.expected.intentOutcome[row.actionId].status).toBe(
          row.afterDigestMatches ? 'verified' : 'failed',
        );
  });
});

describe('ledger oracle', () => {
  it.each(LEDGER_CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    for (const index of Object.keys(c.expected.outcomes).map(Number))
      expect(index >= 0 && index < c.ops.length, `op index ${index}`).toBe(
        true,
      );
    for (const op of c.ops)
      if (op.op === 'seed_config')
        expect(CONFIG_DOMAIN[op.key](op.value), `${op.key} in domain`).toBe(
          true,
        );
  });
});

function outcomes(expected: AdmissionOutcome | { anyOf: AdmissionOutcome[] }) {
  return 'anyOf' in expected ? expected.anyOf : [expected];
}

describe('admission oracle', () => {
  it('covers every TEST_PROMPT gate-2 item 1-16', () => {
    const covered = new Set(
      [...ADMISSION_CASES, ...LEASE_CASES, ...SELF_WRITE_CASES].flatMap(
        (c) => c.covers,
      ),
    );
    for (let item = 1; item <= 16; item += 1)
      expect(covered.has(`gate2.${item}`), `gate2.${item}`).toBe(true);
    expect(covered.has('gate2.limits')).toBe(true);
  });

  it('setup values are inside the CONFIG domains', () => {
    for (const key of CONFIG_KEYS)
      expect(CONFIG_DOMAIN[key](SETUP_CONFIG[key])).toBe(true);
  });

  it.each(ADMISSION_CASES.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const ids = ADMISSION_CASES.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const outcome of outcomes(c.expected)) {
      for (const intent of Object.values(outcome.intents)) {
        if (intent.blockReason)
          expect(BLOCK_REASON).toContain(intent.blockReason);
        if (intent.status === 'blocked')
          expect(intent.blockReason ?? 'any').toBeTruthy();
      }
      // Committed set_config intents and action rows agree.
      for (const [key, change] of Object.entries(outcome.config)) {
        if (!change) continue;
        expect(change.versionDelta).toBeGreaterThanOrEqual(0);
        if (
          change.value !== 'unchanged' &&
          (CONFIG_KEYS as readonly string[]).includes(key)
        )
          expect(
            CONFIG_DOMAIN[key as ConfigKey](change.value as ConfigValue),
            `${c.id} ${key}`,
          ).toBe(true);
        if (change.value === 'unchanged') expect(change.versionDelta).toBe(0);
      }
      if (outcome.neverValue)
        expect(outcome.config[outcome.neverValue.key]?.value).not.toBe(
          outcome.neverValue.value,
        );
    }
  });
});

describe('checkout invariants and frozen scenarios', () => {
  it('invariant ids are unique and cover every phase', () => {
    expect(new Set(CHECKOUT_INVARIANTS.map((i) => i.id)).size).toBe(
      CHECKOUT_INVARIANTS.length,
    );
    expect(new Set(CHECKOUT_INVARIANTS.map((i) => i.phase))).toEqual(
      new Set(['read_only', 'probe', 'repair', 'window']),
    );
  });

  const frozen = resolve(APP_ROOT, 'evals/nemodots/frozen');
  const manifest = JSON.parse(
    readFileSync(resolve(frozen, 'manifest.json'), 'utf8'),
  ) as {
    classes: { class: string; file: string; trials: number }[];
    totalTrials: number;
    missionGoal: string;
  };

  it('covers the eight gate-6 scenario classes', () => {
    expect(manifest.classes.map((c) => c.class).sort()).toEqual(
      [
        'benign_unrelated_change',
        'conflicting_observations',
        'dependent_change_after_proposed_repair',
        'healthy_control',
        'provider_disruption',
        'repairable_checkout_fault',
        'second_change_during_repair',
        'worker_crash',
      ].sort(),
    );
  });

  it('trials have unique ids and seeds, in-domain values and >= 3 trials per class', () => {
    const trialIds = new Set<string>();
    const seeds = new Set<number>();
    let total = 0;
    for (const entry of manifest.classes) {
      const scenario = JSON.parse(
        readFileSync(resolve(frozen, entry.file), 'utf8'),
      ) as {
        trials: {
          trialId: string;
          seed: number;
          steps: { key: string; value: ConfigValue }[];
          expected?: { allowedMutationKeys: string[] };
        }[];
        expected: { allowedMutationKeys?: string[] };
      };
      expect(scenario.trials.length).toBe(entry.trials);
      expect(scenario.trials.length).toBeGreaterThanOrEqual(3);
      for (const trial of scenario.trials) {
        expect(trialIds.has(trial.trialId)).toBe(false);
        expect(seeds.has(trial.seed)).toBe(false);
        trialIds.add(trial.trialId);
        seeds.add(trial.seed);
        total += 1;
        for (const step of trial.steps) {
          expect(CONFIG_KEYS as readonly string[]).toContain(step.key);
          expect(
            CONFIG_DOMAIN[step.key as ConfigKey](step.value),
            `${trial.trialId} ${step.key}`,
          ).toBe(true);
        }
        const allowed =
          trial.expected?.allowedMutationKeys ??
          scenario.expected.allowedMutationKeys;
        expect(allowed, `${trial.trialId} allowedMutationKeys`).toBeDefined();
        expect(allowed ?? []).not.toContain('ui.banner_text');
      }
    }
    expect(total).toBe(manifest.totalTrials);
  });

  it('the mission goal names no key, value, fault or class', () => {
    const goal = manifest.missionGoal.toLowerCase();
    for (const word of [
      ...CONFIG_KEYS,
      'namespace',
      'schema',
      'pool',
      'replica',
      'write_enabled',
      'banner',
      'redis',
      'cache',
      'fault',
      'inject',
    ])
      expect(goal.includes(word.toLowerCase()), word).toBe(false);
  });
});
