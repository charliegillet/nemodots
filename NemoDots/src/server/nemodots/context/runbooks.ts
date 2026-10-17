import { posix } from 'node:path';

// Runbook catalogue (finding I13): ids resolve through an explicit map and
// never through a path join of model-supplied text. Pure: resolve() returns a
// path, it does not read files. The team package supplies the map.

export const RUNBOOK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class UnknownRunbookError extends Error {
  constructor(readonly id: unknown) {
    super('unknown runbook id');
    this.name = 'UnknownRunbookError';
  }
}

export type RunbookEntry = { path: string; title: string };

export class RunbookCatalogue {
  readonly #entries: ReadonlyMap<string, RunbookEntry>;
  readonly #baseDir: string | null;

  constructor(
    entries: Readonly<Record<string, RunbookEntry>>,
    baseDir: string | null = null,
  ) {
    const map = new Map<string, RunbookEntry>();
    for (const id of Object.keys(entries)) {
      const entry = entries[id];
      if (!RUNBOOK_ID_PATTERN.test(id))
        throw new RangeError(`invalid runbook id "${id}"`);
      const normalized = posix.normalize(entry.path);
      if (
        entry.path.includes('\0') ||
        entry.path.includes('\\') ||
        posix.isAbsolute(entry.path) ||
        normalized.startsWith('..') ||
        normalized !== entry.path ||
        !entry.path.endsWith('.md')
      )
        throw new RangeError(
          `runbook "${id}" path must be a normalized relative .md path`,
        );
      map.set(id, Object.freeze({ path: entry.path, title: entry.title }));
    }
    this.#entries = map;
    this.#baseDir = baseDir;
  }

  has(id: unknown): boolean {
    return typeof id === 'string' && this.#entries.has(id);
  }

  /** The mapped path (joined to baseDir when one was given). Throws for anything not in the map. */
  resolve(id: unknown): string {
    if (typeof id !== 'string' || !this.#entries.has(id))
      throw new UnknownRunbookError(id);
    const { path } = this.#entries.get(id)!;
    return this.#baseDir === null ? path : posix.join(this.#baseDir, path);
  }

  /** Catalogue listing for `list_runbooks`, sorted by id. */
  list(): { id: string; title: string }[] {
    return [...this.#entries.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((id) => ({ id, title: this.#entries.get(id)!.title }));
  }
}

export function createRunbookCatalogue(
  entries: Readonly<Record<string, RunbookEntry>>,
  baseDir: string | null = null,
): RunbookCatalogue {
  return new RunbookCatalogue(entries, baseDir);
}
