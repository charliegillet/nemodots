// Secret-absence scanning. Collects secret VALUES from the gitignored env
// files and roles.env (in memory only), then counts occurrences in files.
// Only counts, names and file paths are ever reported, never values.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT, WORKTREE_ROOT, parseEnvText } from './common.js';

export interface Needle {
  /** Variable name (never the value). */
  name: string;
  value: string;
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD)/i;
// Names that look secret-ish but are public identifiers or labels.
const NOT_SECRET = /^(OWNER_ID|NEMODOTS_PROBE_WINDOW_MS|.*_URL|.*_MODEL)$/i;

function pushValue(list: Needle[], name: string, value: string) {
  const v = value.trim();
  if (v.length >= 16 && !/^(true|false|none|null|undefined)$/i.test(v))
    list.push({ name, value: v });
}

export function collectNeedles(rolesFiles: string[]): Needle[] {
  const out: Needle[] = [];
  for (const file of [
    path.join(WORKTREE_ROOT, '.env'),
    path.join(APP_ROOT, '.env'),
  ]) {
    if (!existsSync(file)) continue;
    const env = parseEnvText(readFileSync(file, 'utf8'));
    for (const [name, value] of Object.entries(env))
      if (SECRET_NAME.test(name) && !NOT_SECRET.test(name))
        pushValue(out, name, value);
  }
  for (const file of rolesFiles) {
    if (!existsSync(file)) continue;
    const env = parseEnvText(readFileSync(file, 'utf8'));
    for (const [name, value] of Object.entries(env)) {
      if (name === 'NEMODOTS_PROBE_SECRET') pushValue(out, name, value);
      else if (name.startsWith('NEMODOTS_PG_URL_')) {
        try {
          const password = decodeURIComponent(new URL(value).password);
          pushValue(out, `${name}(password)`, password);
        } catch {
          /* unparsable URL: nothing to add */
        }
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((n) => (seen.has(n.value) ? false : seen.add(n.value)));
}

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.html',
  '.css', '.txt', '.log', '.sh', '.sql', '.map', '.svg', '.example', '.out',
  '.ndjson', '.jsonl', '.toml', '',
]);

export interface ScanOptions {
  roots: string[];
  skipDirs: Set<string>;
  /** Absolute paths (files or dirs) never scanned. */
  skipPaths?: string[];
  extensions?: Set<string>;
  maxBytes?: number;
  skipFile?: (relative: string) => boolean;
}

export interface ScanReport {
  filesScanned: number;
  /** needle name -> list of files containing it (paths only) */
  hits: Record<string, string[]>;
  /** pattern name -> number of matches */
  patternHits: Record<string, string[]>;
}

const PATTERNS: { name: string; re: RegExp; ignore?: RegExp }[] = [
  { name: 'openai-style key (sk-...)', re: /\bsk-[A-Za-z0-9_-]{24,}\b/g },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: 'url with embedded password',
    re: /\bpostgres(?:ql)?:\/\/[^:/\s@'"`]+:([^@\s'"`]{8,})@/g,
    // Placeholders and template syntax are not secrets.
    ignore:
      /:(?:password|changeme|secret|\$\{|<|\{|%s|x{3,}|\*{3,}|\[REDACTED\]|\.\.\.)/i,
  },
];

function* walk(
  dir: string,
  options: ScanOptions,
  rel = '',
): Generator<{ abs: string; rel: string }> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = path.join(dir, name);
    const relative = rel ? `${rel}/${name}` : name;
    if (options.skipPaths?.some((p) => abs === p || abs.startsWith(p + path.sep)))
      continue;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (options.skipDirs.has(name)) continue;
      yield* walk(abs, options, relative);
    } else if (st.isFile()) {
      if (options.skipFile?.(relative)) continue;
      const ext = path.extname(name).toLowerCase();
      if (!(options.extensions ?? TEXT_EXT).has(ext)) continue;
      if (st.size > (options.maxBytes ?? 8_000_000)) continue;
      yield { abs, rel: relative };
    }
  }
}

export function scan(needles: Needle[], options: ScanOptions): ScanReport {
  const report: ScanReport = { filesScanned: 0, hits: {}, patternHits: {} };
  for (const root of options.roots) {
    for (const file of walk(root, options)) {
      let text: string;
      try {
        text = readFileSync(file.abs, 'utf8');
      } catch {
        continue;
      }
      report.filesScanned += 1;
      const label = path.relative(APP_ROOT, file.abs);
      for (const needle of needles)
        if (text.includes(needle.value))
          (report.hits[needle.name] ??= []).push(label);
      for (const pattern of PATTERNS) {
        for (const match of text.matchAll(pattern.re)) {
          if (pattern.ignore?.test(match[0])) continue;
          (report.patternHits[pattern.name] ??= []).push(label);
        }
      }
    }
  }
  return report;
}

/** Counts only: needle name -> number of files. Safe to put in a message. */
export function summarize(report: ScanReport) {
  const lines: string[] = [];
  for (const [name, files] of Object.entries(report.hits))
    lines.push(
      `${name}: ${files.length} file(s) e.g. ${[...new Set(files)].slice(0, 3).join(', ')}`,
    );
  for (const [name, files] of Object.entries(report.patternHits))
    lines.push(
      `pattern "${name}": ${files.length} match(es) in ${[...new Set(files)].slice(0, 3).join(', ')}`,
    );
  return lines.length ? lines.join('; ') : 'no matches';
}
