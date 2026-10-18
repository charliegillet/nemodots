import { execFile } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = path.resolve('scripts/nemodots/write-env.mjs');
const SECRET_KEY = 'sk-test-ABCDEF0123456789secret';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function envFile(content: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nemodots-write-env-'));
  dirs.push(dir);
  const file = path.join(dir, '.env');
  writeFileSync(file, content, { mode: 0o600 });
  return file;
}

const write = (file: string, ...args: string[]) =>
  run(process.execPath, [
    SCRIPT,
    '--file',
    file,
    '--instance',
    'ci-unit',
    ...args,
  ]);

it('appends only non-secret NEMODOTS_* values and never echoes the file', async () => {
  const original = `OPENAI_API_KEY=${SECRET_KEY}\nOPENAI_MODEL=m\n`;
  const file = envFile(original);
  const { stdout, stderr } = await write(file, '--mode', 'fixture');
  expect(stdout + stderr).not.toContain(SECRET_KEY);
  const text = readFileSync(file, 'utf8');
  expect(text.startsWith(original)).toBe(true);
  const block = text.slice(original.length);
  expect(block).toContain('NEMODOTS_INSTANCE=ci-unit\n');
  expect(block).toContain('NEMODOTS_PG_PORT=55432\n');
  expect(block).toContain('NEMODOTS_REDIS_URL=redis://127.0.0.1:56379/0\n');
  expect(block).toContain('NEMODOTS_REDIS_PREFIX=nemodots:ci-unit\n');
  expect(block).toContain('NEMODOTS_INFERENCE_MODE=fixture\n');
  expect(block).not.toMatch(
    /NEMODOTS_PG_URL_|NEMODOTS_PROBE_SECRET|postgres:\/\//,
  );
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('replaces its own block on re-run and keeps names the user set', async () => {
  const file = envFile('NEMODOTS_WORKERS=1\nNEMODOTS_PG_PORT=55440\n');
  await write(file);
  const { stdout } = await write(file, '--redis-port', '56400');
  const text = readFileSync(file, 'utf8');
  expect(text.match(/# >>> nemodots/g)).toHaveLength(1);
  expect(text.match(/^NEMODOTS_PG_PORT=/gm)).toHaveLength(1);
  expect(text).toContain('NEMODOTS_PG_PORT=55440\n');
  expect(text).toContain('NEMODOTS_REDIS_PORT=56400\n');
  expect(stdout).toContain('kept user-set NEMODOTS_PG_PORT');
  expect(stdout).not.toContain('55440');
});

it.each([
  ['--pg-port', '5432'],
  ['--redis-port', '6379'],
])('refuses %s %s', async (flag, value) => {
  const file = envFile('');
  await expect(write(file, flag, value)).rejects.toMatchObject({ code: 2 });
  expect(readFileSync(file, 'utf8')).toBe('');
});
