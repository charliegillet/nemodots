import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRunbookCatalogue,
  type RunbookEntry,
} from '../context/runbooks.js';
import type { RunbookLibrary } from './types.js';

// The authorized runbook catalogue (finding I13). Ids resolve through the
// explicit map in context/runbooks.ts and never through a path join of
// model-supplied text. Runbooks describe semantics only: no baseline values,
// no scenario values (finding D7, grep-tested).

export const RUNBOOK_ENTRIES: Readonly<Record<string, RunbookEntry>> =
  Object.freeze({
    'checkout-architecture': {
      path: 'checkout-architecture.md',
      title: 'Checkout architecture, configuration keys and readable sources',
    },
    'cache-semantics': {
      path: 'cache-semantics.md',
      title: 'Cache namespace and schema semantics and value domains',
    },
    'pool-sizing': {
      path: 'pool-sizing.md',
      title: 'Database pool sizing and statement timeout semantics',
    },
    'inventory-routing': {
      path: 'inventory-routing.md',
      title: 'Inventory routing semantics',
    },
    acceptance: {
      path: 'acceptance.md',
      title: 'Acceptance statement',
    },
  });

export const DEFAULT_RUNBOOK_DIR = fileURLToPath(
  new URL('./runbooks/', import.meta.url),
);

export interface RunbookLibraryOptions {
  /** Directory holding the catalogue's files (default: ./runbooks next to this module). */
  dir?: string;
  entries?: Readonly<Record<string, RunbookEntry>>;
}

/** Loads every catalogued file once; a missing file is a startup error, not an empty runbook. */
export function createRunbookLibrary(
  options: RunbookLibraryOptions = {},
): RunbookLibrary {
  const dir = options.dir ?? DEFAULT_RUNBOOK_DIR;
  const catalogue = createRunbookCatalogue(options.entries ?? RUNBOOK_ENTRIES);
  const texts = new Map<string, string>();
  for (const { id } of catalogue.list())
    texts.set(id, readFileSync(join(dir, catalogue.resolve(id)), 'utf8'));
  const titles = new Map(catalogue.list().map((item) => [item.id, item.title]));
  return {
    list: () => catalogue.list(),
    read(id) {
      const resolved = catalogue.resolve(id) && (id as string);
      return {
        id: resolved,
        title: titles.get(resolved) ?? resolved,
        text: texts.get(resolved) ?? '',
      };
    },
    all: () =>
      catalogue.list().map(({ id, title }) => ({
        id,
        title,
        text: texts.get(id) ?? '',
      })),
  };
}
