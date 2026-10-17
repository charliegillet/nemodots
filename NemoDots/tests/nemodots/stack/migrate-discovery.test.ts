import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  defaultMigrationsDir,
  discoverMigrations,
  loadMigration,
} from '../../../src/server/nemodots/db/migrate.js';
import bootstrap, {
  SCHEMAS,
} from '../../../src/server/nemodots/db/migrations/0001_bootstrap.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nemodots-migrations-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files))
    writeFileSync(path.join(dir, name), content);
  return dir;
}

it('discovers migrations by name, ignoring declarations, maps and stray files', async () => {
  const dir = tempDir({
    '0002_ledger.js': '',
    '0001_bootstrap.js': '',
    '0001_bootstrap.d.ts': '',
    '0001_bootstrap.js.map': '',
    'README.md': '',
    'helper.js': '',
    '10_bad.js': '',
  });
  expect(await discoverMigrations(dir, '.js')).toEqual([
    { id: '0001_bootstrap', file: path.join(dir, '0001_bootstrap.js') },
    { id: '0002_ledger', file: path.join(dir, '0002_ledger.js') },
  ]);
});

it('keeps one module per id, preferring the running extension', async () => {
  const dir = tempDir({ '0001_x.ts': '', '0001_x.js': '' });
  expect((await discoverMigrations(dir, '.ts'))[0].file).toMatch(/\.ts$/);
  expect((await discoverMigrations(dir, '.js'))[0].file).toMatch(/\.js$/);
});

it('rejects a module whose id differs from its file name or lacks up()', async () => {
  const dir = tempDir({
    '0001_a.mjs': "export default { id: '0001_b', async up() {} };",
    '0002_c.mjs': "export default { id: '0002_c' };",
  });
  await expect(
    loadMigration({ id: '0001_a', file: path.join(dir, '0001_a.mjs') }),
  ).rejects.toThrow('declares id 0001_b');
  await expect(
    loadMigration({ id: '0002_c', file: path.join(dir, '0002_c.mjs') }),
  ).rejects.toThrow('must export default { id, up(client) }');
});

it('finds 0001_bootstrap in the real migrations directory', async () => {
  const found = await discoverMigrations(defaultMigrationsDir());
  expect(found[0].id).toBe('0001_bootstrap');
  expect(bootstrap.id).toBe('0001_bootstrap');
  expect(SCHEMAS).toEqual(['ledger', 'coordinator', 'checkout', 'control']);
});

it('0001 creates schemas, roles and grants only (no content tables)', async () => {
  const statements: string[] = [];
  await bootstrap.up({
    query: (async (sql: string) => {
      statements.push(sql);
      return { rows: [] };
    }) as never,
  });
  const all = statements.join('\n');
  expect(all).not.toMatch(/CREATE\s+(UNLOGGED\s+)?TABLE/i);
  expect(all).not.toMatch(/CREATE\s+(SEQUENCE|VIEW|FUNCTION|TRIGGER)/i);
  for (const schema of SCHEMAS)
    expect(all).toContain(
      `CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION nemodots_admin`,
    );
  expect(all).toContain('GRANT CONNECT ON DATABASE');
  expect(all).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE nemodots_admin');
  // the control schema is reachable only by the injector and the verifier
  const controlUsage = statements.filter(
    (sql) => sql.startsWith('GRANT USAGE ON SCHEMA') && sql.includes('control'),
  );
  expect(controlUsage.join('\n')).not.toMatch(/nemodots_(app|checkout)\b/);
});
