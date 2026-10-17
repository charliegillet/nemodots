// Findings I1 and I3 at the process boundary, plus the Redis helper.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  liveRequirements,
  resolveInference,
} from '../../../../src/server/nemodots/config/env.js';
import { readRolesFile } from '../../../../src/server/nemodots/config/roles-file.js';
import { unlinkByPrefix, withTestRedis } from '../../helpers/test-redis.js';

const execFileAsync = promisify(execFile);
const STACK = path.resolve('scripts/nemodots/stack.mjs');
const STUB = 'tests/nemodots/integration/stack/fixtures/print-env-names.mjs';
const instance = process.env.NEMODOTS_INSTANCE ?? 'dev';

function envNames(stdout: string) {
  const line = stdout.split('\n').find((text) => text.startsWith('ENV_NAMES '));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice('ENV_NAMES '.length)) as string[];
}

it('I1: live mode reports missingEnv [OPENAI_BASE_URL] with only key and model set', () => {
  const env = { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' };
  expect(liveRequirements(env).missingEnv).toEqual(['OPENAI_BASE_URL']);
  expect(resolveInference(env)).toMatchObject({
    mode: 'blocked',
    missingEnv: ['OPENAI_BASE_URL'],
  });
});

it('I3: the checkout child receives exactly its own role URL and the minimal env', async () => {
  const roles = readRolesFile(process.cwd(), instance);
  // The parent deliberately holds every role URL, as the test runner does.
  const parentEnv = { ...process.env, ...roles, NEMODOTS_INSTANCE: instance };
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [STACK, 'checkout', '--entry', STUB],
    { env: parentEnv },
  );
  const names = envNames(stdout);
  // Names the OS adds to every process itself (macOS CoreFoundation sets
  // __CF_USER_TEXT_ENCODING at startup), measured with an empty env.
  const baseline = envNames(
    (await execFileAsync(process.execPath, [STUB], { env: {} })).stdout,
  );
  expect(baseline.filter((name) => name.startsWith('NEMODOTS_'))).toEqual([]);
  expect(names).toEqual(
    [
      ...new Set([
        'LC_ALL',
        'NEMODOTS_CHECKOUT_PORT',
        'NEMODOTS_PG_URL_CHECKOUT',
        'NEMODOTS_PROBE_SECRET',
        'NEMODOTS_REDIS_PREFIX',
        'NEMODOTS_REDIS_URL',
        'PATH',
        ...baseline,
      ]),
    ].sort(),
  );
  expect(names.filter((name) => name.startsWith('NEMODOTS_PG_URL_'))).toEqual([
    'NEMODOTS_PG_URL_CHECKOUT',
  ]);
  for (const value of Object.values(roles))
    expect(stdout + stderr).not.toContain(value);
});

it('stack.mjs refuses a checkout entry outside tests/nemodots', async () => {
  await expect(
    execFileAsync(
      process.execPath,
      [STACK, 'checkout', '--entry', 'package.json'],
      {
        env: { ...process.env, NEMODOTS_INSTANCE: instance },
      },
    ),
  ).rejects.toMatchObject({ code: 2 });
});

it('roles.env is mode 0600 and holds exactly the five role URLs and the probe secret', () => {
  const roles = readRolesFile(process.cwd(), instance);
  expect(Object.keys(roles).sort()).toEqual([
    'NEMODOTS_PG_URL_ADMIN',
    'NEMODOTS_PG_URL_APP',
    'NEMODOTS_PG_URL_CHECKOUT',
    'NEMODOTS_PG_URL_INJECTOR',
    'NEMODOTS_PG_URL_VERIFIER',
    'NEMODOTS_PROBE_SECRET',
  ]);
  const passwords = Object.entries(roles)
    .filter(([name]) => name.startsWith('NEMODOTS_PG_URL_'))
    .map(([, value]) => new URL(value).password);
  expect(new Set(passwords).size).toBe(5);
  for (const password of passwords) expect(password).toMatch(/^[0-9a-f]{48}$/);
  // The server log must not contain a role password (verifiers are pre-hashed).
  const log = readFileSync(
    path.resolve('.local', instance, 'logs', 'postgres.log'),
    'utf8',
  );
  for (const password of passwords) expect(log).not.toContain(password);
});

it('withTestRedis isolates keys by prefix and UNLINKs only its own', async () => {
  let outsider = '';
  await withTestRedis(async (outer) => {
    outsider = `${outer.prefix}:keep`;
    await outer.client.set(outsider, '1');
    await withTestRedis(async ({ client, prefix }) => {
      expect(prefix).toMatch(/^nemodots:test:[0-9a-f]{12}$/);
      expect(prefix).not.toBe(outer.prefix);
      await client.set(`${prefix}:a`, '1');
      await client.set(`${prefix}:b:c`, '2');
      expect(await client.ping()).toBe('PONG');
    });
    expect(await outer.client.get(outsider)).toBe('1');
    expect(await unlinkByPrefix(outer.client, outer.prefix)).toBe(1);
    await expect(unlinkByPrefix(outer.client, 'x')).rejects.toThrow('Refusing');
  });
});
