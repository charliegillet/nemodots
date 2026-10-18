// Environment for the sandbox command-line entry points (seed, cli). They are
// normally started through `npm run nemodots:*` (stack.mjs exec/run loads
// roles.env), but `node --import tsx src/server/nemodots/sandbox/cli.ts ...`
// must also work from a plain shell, so role URLs, probe secret and the
// instance's ports are read from .local/<instance>/stack when absent from the
// environment. Values are used in-process and never printed.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type NemoDotsConfig,
  type PgRole,
  parseNemoDotsEnv,
  pgUrl,
  pgUrlEnvName,
} from '../config/env.js';
import { instanceDir, readRolesFile } from '../config/roles-file.js';

type Env = Record<string, string | undefined>;

interface InstanceMeta {
  pgPort?: number;
  redisPort?: number;
  checkoutPort?: number;
}

function readInstanceMeta(appRoot: string, instance: string): InstanceMeta {
  const file = path.join(
    instanceDir(appRoot, instance),
    'stack',
    'instance.json',
  );
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as InstanceMeta;
  } catch {
    return {};
  }
}

/** The environment with roles.env and the instance's ports filled in where unset. */
export function completeEnv(
  env: Env = process.env,
  appRoot = process.cwd(),
): Env {
  const instance = env.NEMODOTS_INSTANCE?.trim() || 'dev';
  const out: Env = { ...env };
  const meta = readInstanceMeta(appRoot, instance);
  if (meta.pgPort && !out.NEMODOTS_PG_PORT)
    out.NEMODOTS_PG_PORT = String(meta.pgPort);
  if (meta.redisPort && !out.NEMODOTS_REDIS_PORT)
    out.NEMODOTS_REDIS_PORT = String(meta.redisPort);
  if (meta.checkoutPort && !out.NEMODOTS_CHECKOUT_PORT)
    out.NEMODOTS_CHECKOUT_PORT = String(meta.checkoutPort);
  const wantsRoles =
    !out.NEMODOTS_PROBE_SECRET ||
    (['admin', 'app', 'injector', 'verifier'] as PgRole[]).some(
      (role) => !out[pgUrlEnvName(role)],
    );
  if (wantsRoles && existsSync(path.join(instanceDir(appRoot, instance)))) {
    try {
      const roles = readRolesFile(appRoot, instance);
      for (const [name, value] of Object.entries(roles))
        if (!out[name]) out[name] = value;
    } catch {
      // surfaced later as "<NAME> is not set"
    }
  }
  return out;
}

export function loadConfig(
  env: Env = process.env,
  appRoot = process.cwd(),
): NemoDotsConfig {
  return parseNemoDotsEnv(completeEnv(env, appRoot));
}

export function roleUrl(config: NemoDotsConfig, role: PgRole) {
  return pgUrl(config, role);
}
