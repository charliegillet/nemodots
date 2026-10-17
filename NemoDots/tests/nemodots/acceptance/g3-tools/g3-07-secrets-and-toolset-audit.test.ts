// Gate 3 static and artifact audits. No secret value is ever printed: failures name the variable and the file only.
//   [TP3.7]  Crusoe / Intelligence / probe / role credentials are server-side only: absent from the built client
//            assets, public/, index.html and the client source tree.
//   [TP3.4]  The model-facing code (team tools, interception, context compiler, inference adapter) has no shell,
//            child-process, Docker socket, raw DB or Redis client, and does not read database credentials.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_ROOT,
  EntryPointMissingError,
  rel,
  secretsPresentIn,
  visibleSecrets,
  walkFiles,
} from './g3-support.js';

const read = (path: string) => readFileSync(path, 'utf8');

function textFiles(dir: string, pattern = /\.(ts|tsx|js|mjs|md|json|css|html)$/) {
  return walkFiles(dir).filter((file) => pattern.test(file));
}

describe('[TP3.7] secrets stay server-side', () => {
  it('[TP3.7] the audit can see the secrets it scans for (a clean result is meaningful)', () => {
    const names = visibleSecrets().map((s) => s.name);
    // Presence of a variable is not proof it works (TEST_PROMPT), but the scan is vacuous with no values at all.
    expect(
      names.length,
      'no secret values visible to the verifier: set CRUSOE_API_KEY (worktree .env) or run through stack.mjs exec so roles.env is loaded',
    ).toBeGreaterThan(0);
  });

  it('[TP3.7] built client assets (dist/client), public/ and index.html contain no secret value', () => {
    const dist = join(APP_ROOT, 'dist', 'client');
    if (!existsSync(dist))
      throw new Error(
        'NOT BUILT: dist/client does not exist; run `npm run build` (integrator) before gate 3 can scan built assets.',
      );
    const secrets = visibleSecrets();
    const targets = [
      ...walkFiles(dist),
      ...walkFiles(join(APP_ROOT, 'public')),
      join(APP_ROOT, 'index.html'),
    ].filter((f) => existsSync(f));
    expect(targets.length).toBeGreaterThan(0);
    const leaks: string[] = [];
    for (const file of targets) {
      const names = secretsPresentIn(readFileSync(file), secrets);
      for (const name of names) leaks.push(`${name} in ${rel(file)}`);
    }
    expect(leaks).toEqual([]);
  });

  it('[TP3.7] built client assets carry no credential-shaped string and no server-only configuration name', () => {
    const dist = join(APP_ROOT, 'dist', 'client');
    if (!existsSync(dist)) throw new Error('NOT BUILT: dist/client does not exist.');
    const findings: string[] = [];
    for (const file of walkFiles(dist)) {
      if (!/\.(js|mjs|css|html|map|json)$/.test(file)) continue;
      const text = readFileSync(file, 'utf8');
      const checks: [string, RegExp][] = [
        ['nvidia/crusoe style key', /nvapi-[A-Za-z0-9_-]{16,}/],
        ['OpenAI style key', /\bsk-(proj-)?[A-Za-z0-9_]{32,}\b/],
        ['PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
        ['connection string with password', /(postgres(ql)?|redis):\/\/[^\s"'`/:@]+:[^\s"'`@]{3,}@/],
        ['role URL env name', /NEMODOTS_PG_URL_(ADMIN|APP|CHECKOUT|INJECTOR|VERIFIER)/],
        ['probe secret env name', /NEMODOTS_PROBE_SECRET/],
        ['roles.env reference', /roles\.env/],
        ['Crusoe key assignment', /CRUSOE_API_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{8,}/],
      ];
      for (const [label, pattern] of checks)
        if (pattern.test(text)) findings.push(`${label} in ${rel(file)}`);
    }
    expect(findings).toEqual([]);
  });

  it('[TP3.7] the client source tree imports only the shared contracts from the NemoDots server tree and reads no process environment', () => {
    const client = join(APP_ROOT, 'src', 'client');
    const problems: string[] = [];
    for (const file of textFiles(client, /\.(ts|tsx)$/)) {
      const text = read(file);
      const imports = [...text.matchAll(/from\s+['"]([^'"]*server\/nemodots[^'"]*)['"]/g)];
      for (const match of imports)
        if (!/server\/nemodots\/contracts(\/|\.|')/.test(match[1] + "'"))
          problems.push(`${rel(file)} imports ${match[1]}`);
      if (/process\.env/.test(text)) problems.push(`${rel(file)} reads process.env`);
    }
    expect(problems).toEqual([]);
  });

  it('[TP3.7] the Vite configuration does not expose the whole environment to the client', () => {
    const config = read(join(APP_ROOT, 'vite.config.ts'));
    expect(config).not.toMatch(/define\s*:\s*\{[^}]*process\.env/);
    expect(config).not.toMatch(/envPrefix\s*:\s*['"`]{2}/);
    expect(config).not.toMatch(/envPrefix\s*:\s*\[[^\]]*['"`]{2}/);
    expect(config).not.toMatch(/envPrefix\s*:\s*\[[^\]]*['"`](NEMODOTS|CRUSOE|OPENAI|CPK|INTELLIGENCE)/);
  });

  it('[TP3.7] no env file or role file is under public/ or dist/', () => {
    const served = [...walkFiles(join(APP_ROOT, 'public')), ...walkFiles(join(APP_ROOT, 'dist'))];
    const bad = served.filter((f) => /(^|\/)(\.env[^/]*|roles\.env|.*\.pem|id_rsa[^/]*)$/.test(f));
    expect(bad.map(rel)).toEqual([]);
  });
});

const MODEL_FACING = ['team', 'interception', 'context', 'inference'] as const;

describe('[TP3.4] the model-facing code has no shell, Docker socket, raw database or Redis access', () => {
  const root = join(APP_ROOT, 'src', 'server', 'nemodots');

  it('[TP3.4] the incident toolset module (team/) exists: the audit cannot certify an absent toolset', () => {
    const tools = join(root, 'team', 'tools.ts');
    if (!existsSync(tools))
      throw new EntryPointMissingError(
        'src/server/nemodots/team/tools.ts',
        'TOOL_COVERAGE section 1 names it as the registration point of the nine team tools',
      );
  });

  it.each(MODEL_FACING.map((dir) => [dir] as const))(
    '[TP3.4] %s/ contains no child_process, shell execution, Docker socket, eval or dynamic code loading',
    (dir) => {
      const folder = join(root, dir);
      if (!existsSync(folder))
        throw new EntryPointMissingError(`src/server/nemodots/${dir}/`, 'directory does not exist');
      const banned: [string, RegExp][] = [
        ['child_process', /\bchild_process\b/],
        ['process spawn/exec call', /\b(execSync|execFileSync|execFile|spawnSync|spawn|fork)\s*\(/],
        ['Docker socket / host', /docker\.sock|DOCKER_HOST|\/var\/run\/docker/i],
        ['eval / Function constructor', /\beval\s*\(|new\s+Function\s*\(/],
        ['vm module', /from\s+['"]node:vm['"]|require\(['"]vm['"]\)/],
        ['worker threads', /node:worker_threads/],
        ['shell invocation string', /['"`](\/bin\/(ba)?sh|bash -c|sh -c|cmd\.exe)/],
      ];
      const findings: string[] = [];
      for (const file of textFiles(folder, /\.(ts|js|mjs)$/)) {
        read(file)
          .split('\n')
          .forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            for (const [label, pattern] of banned)
              if (pattern.test(line)) findings.push(`${label}: ${rel(file)}:${i + 1}`);
          });
      }
      expect(findings).toEqual([]);
    },
  );

  it.each(['team', 'interception', 'context'].map((dir) => [dir] as const))(
    '[TP3.4] %s/ opens no database or Redis connection and reads no role URL, probe secret or provider key from the environment',
    (dir) => {
      const folder = join(root, dir);
      if (!existsSync(folder))
        throw new EntryPointMissingError(`src/server/nemodots/${dir}/`, 'directory does not exist');
      const banned: [string, RegExp][] = [
        ['pg import', /^\s*import\s+(?!type\b)[^;]*from\s+['"]pg['"]|require\(['"]pg['"]\)/],
        ['redis import', /^\s*import\s+(?!type\b)[^;]*from\s+['"](redis|ioredis)['"]/],
        ['pool/client construction', /new\s+(Pool|Client)\s*\(|createClient\s*\(/],
        ['role URL or probe secret', /NEMODOTS_PG_URL_[A-Z]+|NEMODOTS_PROBE_SECRET|NEMODOTS_REDIS_URL/],
        ['provider key read', /process\.env\.(CRUSOE_API_KEY|OPENAI_API_KEY|CPK_INTELLIGENCE_API_KEY|INTELLIGENCE_API_KEY)/],
        ['direct pool import', /from\s+['"][./]+\/?(\.\.\/)*db\/(pool|tx)\.js['"]/],
      ];
      const findings: string[] = [];
      for (const file of textFiles(folder, /\.(ts|js|mjs)$/)) {
        read(file)
          .split('\n')
          .forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            for (const [label, pattern] of banned)
              if (pattern.test(line)) findings.push(`${label}: ${rel(file)}:${i + 1}`);
          });
      }
      expect(findings).toEqual([]);
    },
  );

  it('[TP3.4] the Docker socket, DOCKER_HOST and host-shell fallbacks do not appear anywhere in the NemoDots server tree outside comments', () => {
    const findings: string[] = [];
    for (const file of textFiles(root, /\.(ts|js|mjs)$/)) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/docker\.sock|DOCKER_HOST|\/var\/run\/docker/i.test(line))
            findings.push(`${rel(file)}:${i + 1}`);
        });
    }
    expect(findings).toEqual([]);
  });

  it('[TP3.4] runbooks the model can read contain no connection string, key, token or password', () => {
    const folder = join(root, 'team', 'runbooks');
    if (!existsSync(folder))
      throw new EntryPointMissingError('src/server/nemodots/team/runbooks/', 'directory does not exist');
    const files = readdirSync(folder).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    const secrets = visibleSecrets();
    const findings: string[] = [];
    for (const file of files) {
      const text = read(join(folder, file));
      if (/(postgres(ql)?|redis):\/\/[^\s)]*@/i.test(text)) findings.push(`connection string in ${file}`);
      if (/nvapi-|\bsk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]\s*\S+/i.test(text))
        findings.push(`credential-shaped text in ${file}`);
      for (const name of secretsPresentIn(text, secrets)) findings.push(`${name} value in ${file}`);
    }
    expect(findings).toEqual([]);
  });
});
