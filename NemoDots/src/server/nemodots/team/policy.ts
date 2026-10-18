// Team runtime policies (W4.1). Single source of truth for the incident
// mission: `incidentTeamConfig()` is what bootstrap, the live suite, the evals
// and the demo all use, so the live suite proves exactly the behaviour the
// product has. The library default (a TeamConfig without the flag) stays off so
// other callers and unit fixtures can isolate one behaviour at a time. The
// flags are operator settings; `describeTeamPolicy()` returns the policies in
// force for the mission report.
import type { ProviderMode } from '../contracts/index.js';
import type { TeamConfig } from './types.js';

/** Library default; an incident mission does not use it (see incidentTeamConfig). */
export const DEFAULT_REQUIRE_VERIFIER = false;

export function requireVerifierEnabled(
  config: Partial<Pick<TeamConfig, 'requireVerifier'>>,
): boolean {
  return config.requireVerifier ?? DEFAULT_REQUIRE_VERIFIER;
}

/** Call limits of one incident team (the same for every caller). */
export const INCIDENT_TEAM_LIMITS = Object.freeze({
  maxTokens: 1536,
  plannerMaxTokens: 2048,
  waitTimeoutMs: 180_000,
});

/**
 * The incident-mission team config. Pre-change verification is ON: a
 * specialist's reading is independently confirmed by a verifier child before it
 * proposes a change. Only the model, the provider stamp and test timing can
 * vary; the policy flag cannot be overridden through this function.
 */
export function incidentTeamConfig(
  base: { model: string; provider: { host: string; mode: ProviderMode } },
  timing: Partial<Pick<TeamConfig, 'waitPollMs' | 'waitTimeoutMs'>> = {},
): TeamConfig {
  return {
    ...INCIDENT_TEAM_LIMITS,
    ...timing,
    model: base.model,
    provider: base.provider,
    requireVerifier: true,
  };
}

/** The policies in force, for the mission report. Values only, no content. */
export function describeTeamPolicy(config: Partial<TeamConfig>) {
  return {
    preChangeVerification: requireVerifierEnabled(config),
    investigatorClosingCheck:
      'once per investigator attempt without a delegation',
    planRules: [
      'every task includes observe',
      'every investigator includes delegate',
      ...(requireVerifierEnabled(config)
        ? ['every specialist includes delegate (to obtain verification)']
        : []),
    ],
    maxIterations: config.maxIterations ?? 12,
    tokenBudget:
      'input + output tokens per attempt; cached reported separately',
  } as const;
}
