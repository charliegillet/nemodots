import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..', '..');
const setup = readFileSync(
  path.join(root, 'docs', 'nemodots', 'SETUP.md'),
  'utf8',
);
const demo = readFileSync(
  path.join(root, 'docs', 'nemodots', 'DEMO.md'),
  'utf8',
);

// Section 3: the key-entry snippet, taken verbatim from the doc.
function keySnippet(): string {
  const section = setup.slice(
    setup.indexOf('## 3.'),
    setup.indexOf('### The three required'),
  );
  const blocks = [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map(
    (m) => m[1],
  );
  const block = blocks.find((b) => b.includes('OPENAI_API_KEY'));
  if (!block) throw new Error('key snippet not found');
  // stty needs a tty; the test feeds stdin from a pipe, so make stty a no-op.
  return block.replace('stty -echo;', 'true;').replace('stty echo;', 'true;');
}

function run(shell: string, input: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-setup-'));
  const env = path.join(dir, '.env');
  writeFileSync(env, 'OPENAI_API_KEY=\nOPENAI_MODEL=x\n', { mode: 0o644 });
  const r = spawnSync(shell, ['-c', keySnippet()], {
    cwd: dir,
    input,
    encoding: 'utf8',
  });
  return {
    r,
    text: readFileSync(env, 'utf8'),
    mode: statSync(env).mode & 0o777,
  };
}

describe('SETUP.md key snippet', () => {
  for (const shell of ['bash', 'zsh']) {
    const available = spawnSync(shell, ['-c', 'true']).status === 0;
    (available ? it : it.skip)(
      `stores the key and sets mode 0600 under ${shell}`,
      () => {
        const { r, text, mode } = run(shell, 'fake-key\n');
        expect(text).toContain('OPENAI_API_KEY=fake-key');
        expect(r.stdout).toContain('key saved to .env');
        expect(mode).toBe(0o600);
      },
    );
    (available ? it : it.skip)(`refuses an empty key under ${shell}`, () => {
      const { r, text } = run(shell, '\n');
      expect(r.stderr).toContain('empty key');
      expect(r.stdout).not.toContain('key saved');
      expect(text).toContain('OPENAI_API_KEY=\n');
    });
  }

  it('does not use read -p and tells the operator to chmod .env', () => {
    expect(setup).not.toMatch(/read -rs -p/);
    expect(setup).toContain('chmod 600 .env');
  });
});

describe('DEMO.md manual injector run', () => {
  it('documents the long timeout and that a timeout cancels waiting steps', () => {
    expect(demo).toContain('--timeout-ms 300000');
    expect(demo).toMatch(/timeout cancels every step still waiting/);
    expect(demo).toMatch(/second terminal/);
  });
  it('flags W5.1-dependent content as unverified', () => {
    expect(setup).toContain('NOT YET VERIFIED, depends on W5.1');
    expect(demo).toContain('Not yet verified.');
  });
});
