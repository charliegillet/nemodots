// Scenario manifests (evals/nemodots/scenarios/*.json): the injector's input
// and the evaluation oracle's reference. A manifest carries the INJECTED VALUE
// of every step (D10) so the oracle can score "correctly refrained because the
// key was already repaired". Manifests are private to the injector and the
// verifier: nothing here is serialized into model context, receipts or SSE.
//
// `seed` selects held-out variations deterministically: `valueChoices` /
// array-valued `values` pick one element, `delayMsRange` picks a delay. The
// same (manifest, seed) always resolves to the same steps.
//
// This module reads the DEVELOPMENT set only (evals/nemodots/scenarios). The
// verifier's frozen set lives elsewhere and is passed in by directory.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { digest } from '../contracts/digest.js';
import { CONFIG_MEMBER_KEY_PATTERN } from '../contracts/ids.js';
import { isConfigKey, validateConfigValue } from './config-schema.js';
import type { ConfigScalar } from './version-authority.js';

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const KeySchema = z.string().regex(CONFIG_MEMBER_KEY_PATTERN);
const DelaySchema = z.number().int().min(0).max(600_000);

const TriggerSchema = z.union([
  z.object({ type: z.literal('immediate') }).strict(),
  z
    .object({
      type: z.literal('delay'),
      delayMs: DelaySchema.optional(),
      delayMsRange: z.tuple([DelaySchema, DelaySchema]).optional(),
    })
    .strict()
    .refine(
      (t) => (t.delayMs === undefined) !== (t.delayMsRange === undefined),
      {
        message: 'delay needs exactly one of delayMs, delayMsRange',
      },
    ),
]);

const StepSchema = z
  .object({
    kind: z.enum([
      'set_config',
      'insert_config',
      'delete_config',
      'dependent_change_after_proposal',
    ]),
    key: KeySchema.optional(),
    value: ScalarSchema.optional(),
    valueChoices: z.array(ScalarSchema).min(1).max(8).optional(),
    /** dependent_change_after_proposal: target key -> injected value (or choices) */
    values: z
      .record(KeySchema, z.union([ScalarSchema, z.array(ScalarSchema).min(1)]))
      .optional(),
    trigger: TriggerSchema.optional(),
    /** Step indexes that must have been applied before this step may run. */
    after: z.array(z.number().int().min(0)).optional(),
    /** dependent_change_after_proposal: give up after this long (default 600000). */
    timeoutMs: DelaySchema.optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export const SCENARIO_CLASSES = [
  'healthy_control',
  'benign_change',
  'repairable_checkout_fault',
  'dependent_change_after_proposal',
  'second_change_during_repair',
  'conflicting_observations',
  'diverging_edges',
] as const;

const OracleSchema = z
  .object({
    faultClass: z.enum(['none', 'B1', 'F1', 'F2', 'F3', 'F4', 'F5', 'multi']),
    expectation: z.enum(['no_action_required', 'repair_required']),
    symptoms: z.array(z.string().max(300)).max(12),
    /** Bounded repairs the oracle accepts. */
    acceptableRepairs: z
      .array(
        z
          .object({
            action: z.enum(['set_config', 'flush_cache_namespace']),
            key: KeySchema,
            /** Acceptable end values (omitted: any value in the key's domain that restores health). */
            values: z.array(ScalarSchema).optional(),
          })
          .strict(),
      )
      .max(12),
    /** Keys a correct team leaves alone. */
    mustNotChange: z.array(KeySchema).max(12),
    /** diverging_edges: which evidence each branch should read independently. */
    independentReads: z
      .record(z.string(), z.array(z.string().max(120)).max(12))
      .optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

export const ScenarioManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    version: z.number().int().min(1),
    class: z.enum(SCENARIO_CLASSES),
    description: z.string().min(1).max(800),
    /** What must already be true of the world before the steps run. */
    prerequisites: z.array(z.string().max(300)).max(8).optional(),
    steps: z.array(StepSchema).max(12),
    oracle: OracleSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    manifest.steps.forEach((step, index) => {
      const at = (field: string) => ['steps', index, field];
      const dependent = step.kind === 'dependent_change_after_proposal';
      if (dependent) {
        if (!step.values || !Object.keys(step.values).length)
          ctx.addIssue({
            code: 'custom',
            path: at('values'),
            message: 'a dependent change needs values',
          });
        if (step.key || step.value !== undefined || step.valueChoices)
          ctx.addIssue({
            code: 'custom',
            path: at('key'),
            message: 'a dependent change uses values, not key/value',
          });
        if (step.trigger)
          ctx.addIssue({
            code: 'custom',
            path: at('trigger'),
            message: 'a dependent change is triggered by a proposal',
          });
      } else {
        if (!step.key)
          ctx.addIssue({
            code: 'custom',
            path: at('key'),
            message: 'key required',
          });
        if (step.values)
          ctx.addIssue({
            code: 'custom',
            path: at('values'),
            message: 'values is only for dependent changes',
          });
        const wantsValue = step.kind !== 'delete_config';
        const given =
          (step.value !== undefined ? 1 : 0) + (step.valueChoices ? 1 : 0);
        if (wantsValue && given !== 1)
          ctx.addIssue({
            code: 'custom',
            path: at('value'),
            message: 'exactly one of value, valueChoices is required',
          });
        if (!wantsValue && given !== 0)
          ctx.addIssue({
            code: 'custom',
            path: at('value'),
            message: 'delete_config carries no value',
          });
      }
      for (const prerequisite of step.after ?? [])
        if (prerequisite >= index)
          ctx.addIssue({
            code: 'custom',
            path: at('after'),
            message: 'after must reference earlier steps',
          });
      // Injected values must be legal in the key's domain: a scenario injects
      // faults the checkout can run with, never unparseable configuration.
      const check = (key: string, value: ConfigScalar) => {
        if (isConfigKey(key) && !validateConfigValue(key, value).ok)
          ctx.addIssue({
            code: 'custom',
            path: at('value'),
            message: `value for ${key} is outside its domain`,
          });
      };
      if (step.key && step.kind !== 'delete_config') {
        if (step.value !== undefined) check(step.key, step.value);
        for (const choice of step.valueChoices ?? []) check(step.key, choice);
      }
      for (const [key, raw] of Object.entries(step.values ?? {}))
        for (const choice of Array.isArray(raw) ? raw : [raw])
          check(key, choice);
    });
  });

export type ScenarioManifest = z.infer<typeof ScenarioManifestSchema>;
export type ManifestStep = ScenarioManifest['steps'][number];

export interface ResolvedStep {
  index: number;
  kind: ManifestStep['kind'];
  trigger: 'immediate' | 'delay' | 'on_action_proposed';
  delayMs: number | null;
  key: string | null;
  value: ConfigScalar | null;
  /** dependent changes: target key -> value */
  values: Record<string, ConfigScalar> | null;
  after: number[];
  timeoutMs: number;
}

export const DEFAULT_DEPENDENT_TIMEOUT_MS = 600_000;

/** mulberry32 over a 32-bit state derived from (seed, scenario id). */
export function seededRandom(seed: number, label: string) {
  let state = (seed >>> 0) ^ parseInt(digest(label).slice(0, 8), 16);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resolveScenario(
  manifest: ScenarioManifest,
  seed: number,
): ResolvedStep[] {
  const random = seededRandom(seed, manifest.id);
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)];
  return manifest.steps.map((step, index) => {
    const dependent = step.kind === 'dependent_change_after_proposal';
    const trigger: ResolvedStep['trigger'] = dependent
      ? 'on_action_proposed'
      : (step.trigger?.type ?? 'immediate');
    let delayMs: number | null = null;
    if (step.trigger?.type === 'delay') {
      if (step.trigger.delayMs !== undefined) delayMs = step.trigger.delayMs;
      else {
        const [low, high] = step.trigger.delayMsRange!;
        delayMs = low + Math.floor(random() * (Math.max(high, low) - low + 1));
      }
    }
    let value: ConfigScalar | null = null;
    if (step.value !== undefined) value = step.value;
    else if (step.valueChoices) value = pick(step.valueChoices);
    let values: Record<string, ConfigScalar> | null = null;
    if (step.values) {
      values = {};
      for (const key of Object.keys(step.values).sort()) {
        const raw = step.values[key];
        values[key] = Array.isArray(raw) ? pick(raw) : raw;
      }
    }
    return {
      index,
      kind: step.kind,
      trigger,
      delayMs,
      key: step.key ?? null,
      value,
      values,
      after: [...(step.after ?? [])],
      timeoutMs: step.timeoutMs ?? DEFAULT_DEPENDENT_TIMEOUT_MS,
    };
  });
}

export const defaultScenarioDir = (root = process.cwd()) =>
  path.resolve(root, 'evals', 'nemodots', 'scenarios');

const SCENARIO_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parseManifest(text: string): ScenarioManifest {
  return ScenarioManifestSchema.parse(JSON.parse(text));
}

/** Loads one manifest by id from `dir` (never a path: ids are validated). */
export function loadScenario(
  id: string,
  dir = defaultScenarioDir(),
): ScenarioManifest {
  if (!SCENARIO_ID.test(id)) throw new Error('invalid scenario id');
  const manifest = parseManifest(
    readFileSync(path.join(dir, `${id}.json`), 'utf8'),
  );
  if (manifest.id !== id)
    throw new Error(`scenario file ${id}.json declares id ${manifest.id}`);
  return manifest;
}

export function listScenarios(dir = defaultScenarioDir()): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((id) => SCENARIO_ID.test(id))
    .sort();
}

export const manifestDigest = (manifest: ScenarioManifest) => digest(manifest);
