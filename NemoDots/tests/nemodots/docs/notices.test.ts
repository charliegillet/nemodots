import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..', '..');
const script = path.join(root, 'scripts', 'nemodots', 'notices.mjs');

async function load() {
  return (await import(/* @vite-ignore */ script)) as {
    collectPackages: (lock: unknown) => {
      name: string;
      version: string;
      license: string | null;
    }[];
    renderNotices: (lockText: string) => string;
  };
}

const lock = (packages: Record<string, unknown>) =>
  JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } });

describe('notices.mjs', () => {
  it('skips dev packages, links and the root, and collapses path duplicates', async () => {
    const { collectPackages } = await load();
    const rows = collectPackages(
      JSON.parse(
        lock({
          'node_modules/a': { version: '1.0.0', license: 'MIT' },
          'node_modules/x/node_modules/a': { version: '1.0.0', license: 'MIT' },
          'node_modules/b': { version: '2.0.0', license: 'ISC', dev: true },
          'node_modules/c': { link: true, resolved: 'x' },
          'node_modules/@s/d': { version: '3.1.0', license: 'Apache-2.0' },
        }),
      ),
    );
    expect(rows.map((r) => `${r.name}@${r.version}`)).toEqual([
      '@s/d@3.1.0',
      'a@1.0.0',
    ]);
  });

  it('lists a package without a license separately and never guesses one', async () => {
    const { renderNotices } = await load();
    const text = renderNotices(
      lock({
        'node_modules/mystery': { version: '9.9.9' },
        'node_modules/khroma': { version: '2.1.0' },
        'node_modules/ok': { version: '1.0.0', license: 'MIT' },
      }),
    );
    expect(text).toContain('## Packages without a license field');
    expect(text).toContain('`mystery@9.9.9`: The lockfile records no license');
    expect(text).toContain('Treated as MIT, unverified');
    expect(text).toContain('### MIT (1)');
    expect(text).not.toMatch(/### MIT \(2\)/);
  });

  it('is deterministic and carries the lockfile digest', async () => {
    const { renderNotices } = await load();
    const text = lock({
      'node_modules/ok': { version: '1.0.0', license: 'MIT' },
    });
    expect(renderNotices(text)).toBe(renderNotices(text));
    expect(renderNotices(text)).toMatch(/sha256 `[0-9a-f]{64}`/);
    expect(renderNotices(text)).not.toBe(
      renderNotices(
        lock({ 'node_modules/ok': { version: '1.0.1', license: 'MIT' } }),
      ),
    );
  });

  it('keeps the upstream attribution in the committed file', () => {
    const text = readFileSync(
      path.join(root, 'THIRD_PARTY_NOTICES.md'),
      'utf8',
    );
    expect(text).toContain('OpenDots');
    expect(text).toContain('ab39f2508f3fd23a949837622456f3d61a108e9a');
    expect(text).toContain('khroma@2.1.0');
  });

  it('--check passes for the committed file and rejects unknown arguments', () => {
    const out = execFileSync('node', [script, '--check'], {
      encoding: 'utf8',
    });
    expect(out).toContain('is current');
    const bad = spawnSync('node', [script, '--bogus'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
  });
});
