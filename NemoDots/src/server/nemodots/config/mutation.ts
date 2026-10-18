// NEMODOTS_MUTATION=<name> (ACCEPTANCE_CONTRACT sections 4.2 and 6): the six
// named mutations of the gate-8 catalogue. Each one switches OFF exactly one
// safety guard so the oracle can prove that some test notices. They exist only
// for mutation runs and are INERT UNLESS SET.
//
// Safety rules, all enforced here and nowhere else:
//   - the variable is read ONCE, in this module (cached for the process);
//   - it is honoured only when NEMODOTS_TEST_HOOKS=1; set without it, the
//     process refuses to use it (MutationConfigError on first use, and
//     assertMutationConfig() for start-up code);
//   - it is never honoured in a run labelled live (the resolved inference mode
//     is `live`: every live requirement present);
//   - an unknown name is refused, never ignored;
//   - mutationLabel() names the active mutation so health, telemetry and
//     reports can label a mutated run; it can never pass as a clean one.
import { resolveInference } from './env.js';

export const MUTATIONS = Object.freeze([
  'bypass_final_version_check',
  'drop_inherited_edges',
  'ignore_fencing',
  'accept_duplicate_differing_payloads',
  'skip_effect_marker',
  'skip_freshness',
] as const);
export type Mutation = (typeof MUTATIONS)[number];

export class MutationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutationConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Pure validation of an environment; throws MutationConfigError when it must be refused. */
export function parseMutation(env: Env): Mutation | null {
  const raw = env.NEMODOTS_MUTATION?.trim();
  if (!raw) return null;
  if (!(MUTATIONS as readonly string[]).includes(raw))
    throw new MutationConfigError(
      `NEMODOTS_MUTATION=${raw} is not one of: ${MUTATIONS.join(', ')}.`,
    );
  if (env.NEMODOTS_TEST_HOOKS !== '1')
    throw new MutationConfigError(
      `NEMODOTS_MUTATION=${raw} needs NEMODOTS_TEST_HOOKS=1; refusing to run a mutated build outside a test run.`,
    );
  if (resolveInference(env).mode === 'live')
    throw new MutationConfigError(
      `NEMODOTS_MUTATION=${raw} is never honoured in a run labelled live.`,
    );
  return raw as Mutation;
}

let cached: { value: Mutation | null } | undefined;

/** The active mutation, read once from the process environment. */
export function activeMutation(): Mutation | null {
  if (!cached) {
    const value = parseMutation(process.env);
    if (value)
      process.stderr.write(
        `[nemodots] MUTATED BUILD: ${value} (a safety guard is switched off; results are not clean)\n`,
      );
    cached = { value };
  }
  return cached.value;
}

/** True only while the named mutation is active. */
export function isMutated(name: Mutation): boolean {
  return activeMutation() === name;
}

/** For health, telemetry and reports: the active mutation, or null for a clean run. */
export function mutationLabel(): string | null {
  return activeMutation();
}

/** Start-up check (createNemoDots, worker-main): throws on a refused configuration. */
export function assertMutationConfig(env: Env = process.env): Mutation | null {
  return parseMutation(env);
}

/**
 * Test seam: sets (or clears) the cached mutation. Refused unless
 * NEMODOTS_TEST_HOOKS=1, like the mutation itself.
 */
export function setMutationForTests(name: Mutation | null): void {
  if (process.env.NEMODOTS_TEST_HOOKS !== '1')
    throw new MutationConfigError(
      'setMutationForTests needs NEMODOTS_TEST_HOOKS=1',
    );
  cached = { value: name };
}

/** Test seam: forget the cache so the next call re-reads the environment. */
export function resetMutationForTests(): void {
  if (process.env.NEMODOTS_TEST_HOOKS !== '1')
    throw new MutationConfigError(
      'resetMutationForTests needs NEMODOTS_TEST_HOOKS=1',
    );
  cached = undefined;
}
