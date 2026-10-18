// stack.mjs refusals that must happen before any binary is spawned. These
// run without a stack and never contact a port.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve('scripts/nemodots/stack.mjs');
const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function stack(args: string[], env: Record<string, string> = {}) {
  const clean = { ...process.env };
  for (const name of Object.keys(clean))
    if (name.startsWith('NEMODOTS_')) delete clean[name];
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...clean, ...env } },
    );
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, out: failure.stdout + failure.stderr };
  }
}

const freshInstance = () => {
  const instance = `ci-u${randomBytes(4).toString('hex')}`;
  created.push(path.resolve('.local', instance));
  return instance;
};

it.each([
  [['init', '--pg-port', '5432']],
  [['init', '--redis-port', '6379']],
  [['init', '--checkout-port', '6379']],
])('refuses the user-owned port in %j', async (args) => {
  const instance = freshInstance();
  const result = await stack([...args, '--instance', instance]);
  expect(result.code).toBe(2);
  expect(result.out).toMatch(/refused: ports 5432\/6379/);
  expect(existsSync(path.resolve('.local', instance))).toBe(false);
});

it('refuses NEMODOTS_PG_PORT=5432 from the environment too', async () => {
  const instance = freshInstance();
  const result = await stack(['status', '--instance', instance], {
    NEMODOTS_PG_PORT: '5432',
  });
  expect(result.code).toBe(2);
});

it('refuses an instance directory it did not create', async () => {
  const instance = freshInstance();
  const base = path.resolve('.local', instance);
  mkdirSync(path.join(base, 'pg'), { recursive: true });
  writeFileSync(path.join(base, 'pg', 'PG_VERSION'), '16\n');
  const init = await stack(['init', '--instance', instance]);
  expect(init.code).toBe(1);
  expect(init.out).toContain('was not created by stack.mjs; refusing');
  for (const command of ['start', 'stop', 'status', 'reset-test'])
    expect((await stack([command, '--instance', instance])).code).toBe(1);
  expect(readdirSync(base)).toEqual(['pg']);
});

it('rejects unsafe instance names and unknown commands', async () => {
  expect((await stack(['init', '--instance', '../x'])).code).toBe(2);
  expect((await stack(['explode'])).code).toBe(2);
});

it('run reports not implemented with exit 2 for a script that does not exist yet', async () => {
  const result = await stack([
    'run',
    'src/server/nemodots/sandbox/does-not-exist.ts',
  ]);
  expect(result.code).toBe(2);
  expect(result.out).toContain('not implemented yet');
});
