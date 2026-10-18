// Runbook catalogue (finding I13): ids resolve through an explicit map; the
// model never supplies a path. The files are static Markdown beside this module.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createRunbookCatalogue,
  UnknownRunbookError,
} from '../context/index.js';
import type { RunbookStore } from './types.js';

export const RUNBOOK_ENTRIES = Object.freeze({
  'checkout-architecture': {
    path: 'checkout-architecture.md',
    title: 'Checkout architecture and observable sources',
  },
  'cache-semantics': {
    path: 'cache-semantics.md',
    title: 'Cache namespace and schema semantics',
  },
  'pool-semantics': {
    path: 'pool-semantics.md',
    title: 'Database pool and timeout semantics',
  },
  'routing-semantics': {
    path: 'routing-semantics.md',
    title: 'Inventory routing and order-write semantics',
  },
  acceptance: { path: 'acceptance.md', title: 'Acceptance statement' },
} as const);

const BASE_DIR = fileURLToPath(new URL('./runbooks/', import.meta.url));

export function createRunbookStore(baseDir: string = BASE_DIR): RunbookStore {
  const catalogue = createRunbookCatalogue({ ...RUNBOOK_ENTRIES });
  const cache = new Map<string, string>();
  const text = (id: string) => {
    if (!catalogue.has(id)) throw new UnknownRunbookError(id);
    let value = cache.get(id);
    if (value === undefined) {
      // resolve() returns the mapped relative path; the base is ours.
      value = readFileSync(`${baseDir}${catalogue.resolve(id)}`, 'utf8');
      cache.set(id, value);
    }
    return value;
  };
  return {
    catalogue,
    read(id) {
      const entry = catalogue.list().find((item) => item.id === id);
      if (!entry) throw new UnknownRunbookError(id);
      return { id, title: entry.title, text: text(id) };
    },
    all() {
      return catalogue.list().map((item) => ({ ...item, text: text(item.id) }));
    },
  };
}
