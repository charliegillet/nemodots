// Gate 4 (autonomy and persistence) constants and environment resolution.
// Port block for this suite: checkout 4680, app 4681, scripted provider 4683,
// Redis database index 5 on the NemoDots Redis, database names `acc4_<hex>`.
// Nothing here prints a secret value; values only travel into child process
// environments.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export const G4 = Object.freeze({
  checkoutPort: 4680,
  appPort: 4681,
  providerPort: 4683,
  privateRedisPort: 56385,
  redisDb: 5,
  dbPrefix: 'acc4_',
  redisPrefixRoot: 'nemodots:acc4',
  scratch: resolve(APP_ROOT, '.local/acceptance/g4'),
});

/** The gate-6 neutral goal: no fault, key, value or class is named. */
export const NEUTRAL_GOAL =
  'Investigate the checkout service and restore normal operation if anything is wrong. Acceptance: a fresh order succeeds, inventory stays consistent and health stays ok.';
export const NEUTRAL_CONSTRAINTS = [
  'Change checkout configuration only through proposed actions.',
  'Do not change anything that the evidence does not show is broken.',
];

/** Parses NemoDots/.env without mutating process.env. Never logged. */
export function readDotEnv(): Record<string, string> {
  const file = resolve(APP_ROOT, '.env');
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

export function mergedEnv(): Record<string, string | undefined> {
  return { ...readDotEnv(), ...process.env };
}

export interface LiveStatus {
  configured: boolean;
  missing: string[];
  baseUrl: string | null;
  model: string | null;
}

/** Names only. Live Crusoe cases are BLOCKED when any of the three is absent. */
export function liveStatus(): LiveStatus {
  const env = mergedEnv();
  const missing = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'].filter(
    (name) => !env[name],
  );
  return {
    configured: missing.length === 0,
    missing,
    baseUrl: env.OPENAI_BASE_URL ?? null,
    model: env.OPENAI_MODEL ?? null,
  };
}

export function intelligenceStatus() {
  const env = mergedEnv();
  const key = env.CPK_INTELLIGENCE_API_KEY || env.INTELLIGENCE_API_KEY;
  return {
    configured: Boolean(key),
    missing: key ? [] : ['CPK_INTELLIGENCE_API_KEY'],
  };
}

/** Throws the BLOCKED marker (the suite fails, it never skips or passes). */
export function requireLive(): LiveStatus {
  const status = liveStatus();
  if (!status.configured)
    throw new Error(
      `BLOCKED: live Crusoe/Nemotron credentials are not configured (missing: ${status.missing.join(', ')}). A BLOCKED case is neither PASS nor skipped.`,
    );
  return status;
}

export function requireIntelligence() {
  const status = intelligenceStatus();
  if (!status.configured)
    throw new Error(
      `BLOCKED: CopilotKit Intelligence is not configured (missing: ${status.missing.join(', ')}). LEAD_NOTES says the key is AVAILABLE, so this is a setup defect, not an exemption.`,
    );
}

/** Replace every secret-looking environment value by a marker. */
export function redactor(env: Record<string, string | undefined>) {
  const secrets = Object.entries(env)
    .filter(
      ([name, value]) =>
        value &&
        value.length >= 8 &&
        /KEY|SECRET|TOKEN|PASSWORD|_URL_/i.test(name),
    )
    .map(([, value]) => value as string);
  return (text: string) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('<redacted>');
    return out.replace(
      /postgres(?:ql)?:\/\/[^\s'"]+/g,
      'postgres://<redacted>',
    );
  };
}
