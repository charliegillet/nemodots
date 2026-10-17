// Reader for `.local/<instance>/stack/roles.env`, the 0600 file written by
// `scripts/nemodots/stack.mjs init`. It holds the per-role PostgreSQL URLs and
// the probe secret. Values are returned to the calling process only; nothing
// here logs them, and they are never copied into `.env`.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { NemoDotsEnvError } from './env.js';

export function instanceDir(appRoot: string, instance: string) {
  return path.join(appRoot, '.local', instance);
}

export function rolesFilePath(appRoot: string, instance: string) {
  return path.join(instanceDir(appRoot, instance), 'stack', 'roles.env');
}

export function parseEnvText(text: string) {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    values[name] = line.slice(index + 1).trim();
  }
  return values;
}

/**
 * Reads roles.env for an instance. Refuses a file readable by group/other,
 * because it carries role passwords.
 */
export function readRolesFile(appRoot: string, instance: string) {
  const file = rolesFilePath(appRoot, instance);
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new NemoDotsEnvError(
      ['NEMODOTS_INSTANCE'],
      `roles.env for instance "${instance}" does not exist; run \`npm run nemodots:stack -- init\`.`,
    );
  }
  if (mode & 0o077)
    throw new NemoDotsEnvError(
      ['NEMODOTS_INSTANCE'],
      `roles.env for instance "${instance}" must have mode 0600.`,
    );
  return parseEnvText(readFileSync(file, 'utf8'));
}
