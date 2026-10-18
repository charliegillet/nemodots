// W6.3 demo adversary: shared vocabulary. Written independently of the team,
// evals and sandbox builders. The forbidden sets are derived from the sources
// of truth the agents must never see: the healthy baseline in sandbox/seed.ts
// and the development scenario manifests (read as raw JSON here, not through
// the sandbox manifest loader). Nothing in this file is imported by product
// code.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HEALTHY_BASELINE } from '../../../../src/server/nemodots/sandbox/seed.js';

export const APP_ROOT = path.resolve(import.meta.dirname, '../../../..');
export const TEAM_DIR = path.join(APP_ROOT, 'src/server/nemodots/team');
export const SCENARIO_DIR = path.join(APP_ROOT, 'evals/nemodots/scenarios');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface RawManifest {
  file: string;
  json: Json;
}

/** The development manifests, as raw JSON (never the verifier's frozen set). */
export function rawManifests(): RawManifest[] {
  return readdirSync(SCENARIO_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      json: JSON.parse(readFileSync(path.join(SCENARIO_DIR, file), 'utf8')),
    }));
}

/** Every scalar the manifests inject into configuration, by key. */
export function injectedValues(): Map<string, Set<string | number | boolean>> {
  const out = new Map<string, Set<string | number | boolean>>();
  const add = (key: string, value: unknown) => {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    )
      return;
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(value);
  };
  for (const { json } of rawManifests())
    for (const step of json.steps ?? []) {
      if (step.key) {
        if ('value' in step) add(step.key, step.value);
        for (const v of step.valueChoices ?? []) add(step.key, v);
      }
      for (const [key, values] of Object.entries(step.values ?? {}))
        for (const v of values as unknown[]) add(key, v);
    }
  return out;
}

/** Scenario ids, classes and step kinds, excluding plain English words. */
export function scenarioIdentifiers(): string[] {
  const words = new Set<string>();
  for (const { json } of rawManifests()) {
    words.add(json.id);
    words.add(json.class);
    for (const step of json.steps ?? []) words.add(step.kind);
  }
  // Runbook vocabulary that happens to equal an identifier: `healthy` is an
  // ordinary word, `set_config` the public action name every agent is told
  // about, and `writes_disabled` the checkout's own observable error class
  // (ARCHITECTURE 9.2), returned by the API to any caller.
  for (const common of ['healthy', 'set_config', 'writes_disabled'])
    words.delete(common);
  return [...words].filter(Boolean).sort();
}

/** Manifest and oracle field names: data only the injector and scorer hold. */
export const MANIFEST_VOCABULARY = [
  'valueChoices',
  'acceptableRepairs',
  'mustNotChange',
  'faultClass',
  'independentReads',
  'repair_required',
  'no_action_required',
  'preconditions',
  'warm_cache',
  'delayMsRange',
  'manifestDigest',
  'manifest_digest',
] as const;

/** Control-plane identifiers that must never reach an agent or the event stream. */
export const CONTROL_VOCABULARY = [
  'control.',
  'fault_schedules',
  'fault_schedule',
  'scenario_runs',
  'scenario_run',
  'injector',
  'x-nemodots-probe',
  'nemodots_verifier',
  'nemodots_injector',
] as const;

export const BASELINE = HEALTHY_BASELINE;

/** String values of the healthy baseline (forbidden as substrings in team/**). */
export function baselineStrings(): string[] {
  return Object.values(HEALTHY_BASELINE).filter(
    (value): value is string => typeof value === 'string',
  );
}

/** Number and boolean values of the healthy baseline, as text. */
export function baselineScalars(): string[] {
  return Object.values(HEALTHY_BASELINE)
    .filter((value) => typeof value !== 'string')
    .map(String);
}

/** All case-insensitive hits of `needles` in `text`, with a little context. */
export function hits(text: string, needles: readonly string[]): string[] {
  const lowered = text.toLowerCase();
  const out: string[] = [];
  for (const needle of needles) {
    const n = needle.toLowerCase();
    if (!n) continue;
    let at = lowered.indexOf(n);
    while (at !== -1 && out.length < 50) {
      out.push(
        `${needle} @ "${text.slice(Math.max(0, at - 40), at + n.length + 40).replace(/\s+/g, ' ')}"`,
      );
      at = lowered.indexOf(n, at + n.length);
    }
  }
  return out;
}
