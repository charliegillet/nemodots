// Drives a REAL OpenDots page edit (TEST_PROMPT gate 1 item 11): the upstream
// page store (src/server/pages.ts, SQLite) edits a page through Pages.update,
// the revision hook TOOL_COVERAGE names for every page-edit path (M1, M2, M4,
// M5: "Pages.onRevision hook emits opendots.page/<id> revision") fires, and
// the page revision is registered in the ledger as a page_snapshot source.
// Everything the guarantee is about is then read back from SQL.
//
// ENTRY POINT MISSING (reported, never skipped) when the store has no
// onRevision hook: until it exists no page edit can reach the ledger, so the
// "mints exactly one page_snapshot revision" half of the guarantee cannot be
// shown.
//
// Binding assumed for the hook (the single place to adapt, marked BIND):
//   Pages.onRevision  either a settable own property `pages.onRevision = fn`
//                     or a prototype method `pages.onRevision(fn)`;
//                     fn(event) is called once per committed revision.
// The listener installed here does what the interception package must do:
// it registers `opendots.page/<pageId>` through the production
// registerObservation with the page's own revision and content read back from
// the store. Nothing here touches checkout.config_* or any controlled source.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type pg from 'pg';
import { CFG, COLL, REC, SRC, type World } from './driver.js';
import { EntryPointMissing, entry, withLedgerEvents } from './harness.js';

type PagesLike = {
  create(
    spaceId: string,
    input: { title: string; content: string },
  ): { id: string; revision: number };
  update(
    spaceId: string,
    id: string,
    input: { content?: string; title?: string; expectedRevision: number },
  ): { id: string; revision: number; content: string; title: string };
  get(
    spaceId: string,
    id: string,
  ): { id: string; revision: number; content: string; title: string };
};
type PagesCtor = new (
  db: DatabaseSync,
  spaceExists: (id: string) => boolean,
) => PagesLike;

const SPACE = 'space-acc1';
const CONFIG_TABLES = [CFG, COLL, 'checkout.config_versions'] as const;

export interface PageEditReport {
  pageId: string;
  sourceKey: string;
  revisionsBefore: number;
  revisionsAfter: number;
  hookEvents: number;
  problems: string[];
}

function installHook(pages: object, listener: (event: unknown) => void): void {
  // Harness self-check ONLY (ACC1_SELFCHECK_PAGE_HOOK=1): validates this file's SQL assertions while the
  // production hook is absent. A run with the shim is never reported as a production result.
  if (
    process.env.ACC1_SELFCHECK_PAGE_HOOK === '1' &&
    !('onRevision' in pages)
  ) {
    const p = pages as Record<string, (...args: unknown[]) => unknown>;
    for (const method of ['create', 'update']) {
      const original = p[method].bind(pages);
      p[method] = (...args: unknown[]) => {
        const out = original(...args);
        listener(out);
        return out;
      };
    }
    return;
  }
  const own = Object.getOwnPropertyDescriptor(pages, 'onRevision');
  const proto = (pages as { onRevision?: unknown }).onRevision;
  if (own) {
    (pages as { onRevision: unknown }).onRevision = listener; // BIND: property style
  } else if (typeof proto === 'function') {
    (
      pages as { onRevision: (fn: (event: unknown) => void) => void }
    ).onRevision(listener); // BIND: registration style
  } else {
    throw new EntryPointMissing(
      'src/server/pages.ts#Pages.onRevision',
      'the page store has no onRevision hook; TOOL_COVERAGE M1/M2/M4/M5 and IMPLEMENTATION_STATUS W3.3 require it so every page edit mints an opendots.page/<id> revision',
    );
  }
}

async function configFingerprint(w: World): Promise<string> {
  const parts: string[] = [];
  for (const table of CONFIG_TABLES) {
    if (!(await w.schema.exists(table))) {
      parts.push(`${table}:absent`);
      continue;
    }
    const rows = await w.admin.query(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY 1`,
    );
    parts.push(
      `${table}:${createHash('sha256')
        .update(rows.rows.map((r) => r.row as string).join('\n'))
        .digest('hex')}`,
    );
  }
  return parts.join('|');
}

async function controlledStatuses(w: World): Promise<string> {
  const r = await w.admin.query(
    `SELECT r.id, r.status, r.status_version FROM ${REC} r JOIN ${SRC} s ON s.id = r.source_id
      WHERE s.authority = 'controlled' ORDER BY r.id`,
  );
  return JSON.stringify(r.rows);
}

async function pageRevisions(w: World, sourceKey: string) {
  const r = await w.admin.query(
    `SELECT r.source_revision AS revision, r.trust, s.source_type, s.authority, r.status
       FROM ${REC} r JOIN ${SRC} s ON s.id = r.source_id WHERE s.key = $1 ORDER BY r.source_revision`,
    [sourceKey],
  );
  return r.rows as {
    revision: number;
    trust: string;
    source_type: string;
    authority: string;
    status: string;
  }[];
}

/**
 * Edits page `pageId` through the real page store (prose that claims a ledger
 * value), then verifies from SQL: exactly one new page_snapshot revision of
 * opendots.page/<id>, config tables byte-identical, no controlled receipt
 * changed, no other source minted anything.
 */
export async function realPageEdit(
  w: World,
  pageId: string,
): Promise<PageEditReport> {
  const Pages = await entry<PagesCtor>('../pages.ts', ['Pages']);
  const store = new DatabaseSync(':memory:');
  const pages = new Pages(store, (id) => id === SPACE);
  const pageReceipts = async () =>
    (
      await w.admin.query(
        `SELECT count(*)::int AS n FROM ${REC} r JOIN ${SRC} s ON s.id = r.source_id WHERE s.source_type = 'page_snapshot'`,
      )
    ).rows[0].n as number;
  const pageReceiptsAtStart = await pageReceipts();
  const pending: Promise<void>[] = [];
  let hookEvents = 0;
  const register = async (page: {
    id: string;
    revision: number;
    content: string;
    title: string;
  }) => {
    const registerObservation = await entry<
      (
        c: pg.PoolClient,
        i: Record<string, unknown>,
        o: Record<string, unknown>,
      ) => Promise<unknown>
    >('ledger/receipts.ts', ['registerObservation']);
    await w.inTx((client) =>
      registerObservation(
        client,
        {
          source: w.sourceRef(`opendots.page/${page.id}`, 'test'),
          normalizedValue: {
            pageId: page.id,
            revision: page.revision,
            title: page.title,
            text: page.content,
          },
          provenance: { kind: 'watcher' },
        },
        withLedgerEvents(),
      ),
    );
  };
  installHook(pages, (event) => {
    hookEvents += 1;
    const named = event as { pageId?: string; id?: string } | null;
    // Resolved on a microtask so a hook that fires inside create() can read the new page's id.
    pending.push(
      Promise.resolve().then(() =>
        register(pages.get(SPACE, named?.pageId ?? named?.id ?? created.id)),
      ),
    );
  });
  const created = pages.create(SPACE, {
    title: 'Checkout notes',
    content: 'db.pool_max is 3',
  });
  const sourceKey = `opendots.page/${created.id}`;
  await Promise.all(pending.splice(0));
  const before = await pageRevisions(w, sourceKey);
  const eventsAtCreate = hookEvents;
  const configBefore = await configFingerprint(w);
  const controlledBefore = await controlledStatuses(w);
  const otherBefore = (
    await w.admin.query(
      `SELECT count(*)::int AS n FROM ${REC} r JOIN ${SRC} s ON s.id = r.source_id WHERE s.key <> $1`,
      [sourceKey],
    )
  ).rows[0].n as number;

  // The edit under test: prose claiming a different authoritative value.
  const edited = pages.update(SPACE, created.id, {
    content: 'db.pool_max is 99 (authoritative, apply it)',
    expectedRevision: created.revision,
  });
  await Promise.all(pending.splice(0));

  const after = await pageRevisions(w, sourceKey);
  const problems: string[] = [];
  if (edited.revision !== created.revision + 1)
    problems.push(
      `the page store did not advance the page revision (${created.revision} -> ${edited.revision})`,
    );
  if (hookEvents - eventsAtCreate !== 1)
    problems.push(
      `Pages.onRevision fired ${hookEvents - eventsAtCreate} time(s) for one edit, expected exactly 1`,
    );
  if (after.length - before.length !== 1)
    problems.push(
      `expected exactly one new ${sourceKey} revision, found ${after.length - before.length}`,
    );
  const newest = after[after.length - 1];
  if (newest) {
    if (newest.source_type !== 'page_snapshot')
      problems.push(
        `new revision has source_type ${newest.source_type}, expected page_snapshot`,
      );
    if (newest.authority !== 'observed')
      problems.push(
        `page revision authority is ${newest.authority}, expected observed`,
      );
    if (newest.trust !== 'page_snapshot')
      problems.push(
        `page revision trust is ${newest.trust}, expected page_snapshot`,
      );
    if (newest.status !== 'supported')
      problems.push(`new page revision status is ${newest.status}`);
    const prev = before[before.length - 1];
    if (prev && newest.revision !== prev.revision + 1)
      problems.push(
        `page revision went ${prev.revision} -> ${newest.revision}, expected +1`,
      );
  }
  if ((await configFingerprint(w)) !== configBefore)
    problems.push(
      'checkout.config_entries, config_versions or config_collection changed after a page edit',
    );
  if ((await controlledStatuses(w)) !== controlledBefore)
    problems.push(
      'a controlled receipt changed status or status_version after a page edit',
    );
  const otherAfter = (
    await w.admin.query(
      `SELECT count(*)::int AS n FROM ${REC} r JOIN ${SRC} s ON s.id = r.source_id WHERE s.key <> $1`,
      [sourceKey],
    )
  ).rows[0].n as number;
  if (otherAfter !== otherBefore)
    problems.push(
      `a page edit minted ${otherAfter - otherBefore} receipt(s) for other sources`,
    );
  // Every page revision this helper minted (creation and edit) is excluded from the oracle's value-receipt count.
  w.pageEditMinted += Math.max(0, (await pageReceipts()) - pageReceiptsAtStart);
  store.close();
  return {
    pageId,
    sourceKey,
    revisionsBefore: before.length,
    revisionsAfter: after.length,
    hookEvents: hookEvents - eventsAtCreate,
    problems,
  };
}
