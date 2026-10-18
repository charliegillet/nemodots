// The composed page-revision feed and read receipts (TP-70, findings I4/F4b):
// a page revision or read_space_page result is registered in the ledger, as a
// receipt WITHOUT authority, only for an incident Dot's turn, with the page's
// own Space, against the one active mission whose scope is that Space. Owner
// edits, ordinary Dots, Spaces without a mission and ambiguous Spaces register
// nothing. The tool policy still confines the incident Dot's writes.
import { afterEach, expect, it } from 'vitest';
import pg from 'pg';
import { createNemoDots } from '../../../../src/server/nemodots/bootstrap.js';
import {
  getActivePolicy,
  getInterceptionHooks,
  runInProvenanceScope,
} from '../../../../src/server/nemodots/interception/index.js';
import { WorkspaceStore } from '../../../../src/server/workspace.js';
import { withTestDatabase } from '../../helpers/test-db.js';
import { withTestRedis } from '../../helpers/test-redis.js';

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function world(extraEnv: Record<string, string> = {}) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  closers.push(() => workspace.close());
  const incidentSpace = workspace.createSpace('Incident', 'projection Space');
  const otherSpace = workspace.createSpace('Other', 'unrelated Space');
  let result!: {
    nemodots: ReturnType<typeof createNemoDots>;
    workspace: WorkspaceStore;
    incidentSpace: string;
    otherSpace: string;
    admin: pg.Pool;
    createMission(): Promise<string>;
    sources(key: string): Promise<{ key: string; space_id: string | null }[]>;
  };
  return {
    workspace,
    incidentSpace: incidentSpace.id,
    otherSpace: otherSpace.id,
    async within<T>(fn: (w: typeof result) => Promise<T>) {
      return withTestDatabase(async (db) =>
        withTestRedis(async (redis) => {
          const admin = new pg.Pool({
            connectionString: db.urls.admin,
            max: 2,
          });
          admin.on('error', () => undefined);
          closers.push(() => admin.end());
          const nemodots = createNemoDots(
            {
              NEMODOTS_INSTANCE: 'dev',
              NEMODOTS_PG_URL_APP: db.urls.app,
              NEMODOTS_PG_URL_VERIFIER: db.urls.verifier,
              NEMODOTS_PG_URL_INJECTOR: db.urls.injector,
              NEMODOTS_PROBE_SECRET: 'probe-secret-for-bootstrap-test-0123',
              NEMODOTS_REDIS_URL: redis.url,
              NEMODOTS_REDIS_PREFIX: redis.prefix,
              NEMODOTS_CHECKOUT_URL: 'http://127.0.0.1:4599',
              NEMODOTS_INFERENCE_MODE: 'blocked',
              NEMODOTS_WATCH_INTERVAL_MS: '60000',
              NEMODOTS_WORKERS: '0',
              NEMODOTS_PROJECTION_SPACE_ID: incidentSpace.id,
              ...extraEnv,
            },
            { workspace },
          );
          closers.push(() => nemodots.stop());
          await nemodots.start();
          result = {
            nemodots,
            workspace,
            incidentSpace: incidentSpace.id,
            otherSpace: otherSpace.id,
            admin,
            async createMission() {
              // blocked inference refuses HTTP creation; the coordinator does not
              const mission = await nemodots.coordinator!.control.create({
                goal: 'restore checkout',
              });
              expect(mission.scope.spaceId).toBe(
                extraEnv.NEMODOTS_PROJECTION_SPACE_ID === ''
                  ? null
                  : incidentSpace.id,
              );
              return mission.id as string;
            },
            async sources(key) {
              // the feed is eventual: give it a moment
              for (let i = 0; i < 15; i++) {
                await sleep(100);
                const { rows } = await admin.query(
                  'SELECT key, space_id FROM ledger.sources WHERE key = $1',
                  [key],
                );
                if (rows.length) return rows;
              }
              return [];
            },
          };
          return fn(result);
        }),
      );
    },
  };
}

const turn =
  (incident: boolean) =>
  <T>(fn: () => T) =>
    runInProvenanceScope(
      {
        dotId: incident ? 'incident-dot' : 'ordinary-dot',
        threadId: 't',
        incident,
        dependencyVector: [],
      },
      fn,
    );
const incidentTurn = turn(true);
const ordinaryTurn = turn(false);
const page = (title: string) => ({ title, content: 'c', parentId: null });

it('an incident Dot’s page write in the incident Space registers with that Space and the mission of that Space', async () => {
  const w = await world();
  await w.within(async (ctx) => {
    await ctx.createMission();
    const created = incidentTurn(() =>
      ctx.workspace.pages.create(ctx.incidentSpace, page('Evidence')),
    );
    expect(await ctx.sources(`opendots.page/${created.id}`)).toEqual([
      { key: `opendots.page/${created.id}`, space_id: ctx.incidentSpace },
    ]);
    const receipt = await ctx.admin.query(
      `SELECT r.source_revision, r.trust FROM ledger.observation_receipts r
         JOIN ledger.sources s ON s.id = r.source_id WHERE s.key = $1`,
      [`opendots.page/${created.id}`],
    );
    expect(receipt.rows).toHaveLength(1);
    // evidence without authority
    expect(receipt.rows[0].trust).toBe('page_snapshot');
  });
});

it('nothing is registered for owner edits, ordinary Dots, or a Space without a mission (I4)', async () => {
  const w = await world();
  await w.within(async (ctx) => {
    await ctx.createMission();
    const owner = ctx.workspace.pages.create(ctx.incidentSpace, page('Owner'));
    const ordinary = ordinaryTurn(() =>
      ctx.workspace.pages.create(ctx.incidentSpace, page('Ordinary')),
    );
    const elsewhere = incidentTurn(() =>
      ctx.workspace.pages.create(ctx.otherSpace, page('Other Space')),
    );
    for (const p of [owner, ordinary, elsewhere]) {
      expect(await ctx.sources(`opendots.page/${p.id}`)).toEqual([]);
    }
    const events = await ctx.admin.query(
      `SELECT count(*)::int AS n FROM coordinator.events WHERE payload::text LIKE ANY($1::text[])`,
      [[owner, ordinary, elsewhere].map((p) => `%${p.id}%`)],
    );
    expect(events.rows[0].n).toBe(0);
  });
});

it('a Space with no mission, or with two active missions, cannot be attributed and registers nothing', async () => {
  const w = await world();
  await w.within(async (ctx) => {
    const first = incidentTurn(() =>
      ctx.workspace.pages.create(ctx.incidentSpace, page('No mission')),
    );
    expect(await ctx.sources(`opendots.page/${first.id}`)).toEqual([]);
    // two active missions in the same Space: ambiguous, never "the latest"
    await ctx.createMission();
    await ctx.createMission();
    const second = incidentTurn(() =>
      ctx.workspace.pages.create(ctx.incidentSpace, page('Ambiguous')),
    );
    expect(await ctx.sources(`opendots.page/${second.id}`)).toEqual([]);
  });
});

it('without a projection Space no mission has a Space and no page receipt exists at all', async () => {
  const w = await world({ NEMODOTS_PROJECTION_SPACE_ID: '' });
  await w.within(async (ctx) => {
    await ctx.createMission();
    const created = incidentTurn(() =>
      ctx.workspace.pages.create(ctx.incidentSpace, page('Unscoped')),
    );
    expect(await ctx.sources(`opendots.page/${created.id}`)).toEqual([]);
  });
});

it('read_space_page results register a receipt for an incident turn only', async () => {
  const w = await world();
  await w.within(async (ctx) => {
    await ctx.createMission();
    const created = ctx.workspace.pages.create(ctx.incidentSpace, page('Read'));
    const sink = getInterceptionHooks().sink!;
    // Dot turns are outside the controlled scope: nothing else is recorded
    expect(sink.recordSnapshot).toBeUndefined();
    expect(sink.recordModelCall).toBeUndefined();
    expect(
      sink.identify?.({ dotId: 'incident-dot', threadId: 't' }),
    ).toBeNull();
    const result = {
      id: created.id,
      spaceId: ctx.incidentSpace,
      revision: created.revision,
    };
    const info = {
      toolName: 'read_space_page',
      toolCallId: 'c',
      args: {},
      result,
      resultDigest: 'a'.repeat(64) as never,
    };
    expect(await ordinaryTurn(() => sink.registerToolResult!(info))).toEqual(
      [],
    );
    const entries = (await incidentTurn(() =>
      sink.registerToolResult!(info),
    )) as unknown as { sourceKey: string; receiptId: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].sourceKey).toBe(`opendots.page/${created.id}`);
    // a page of a Space with no mission yields nothing
    const stray = { ...info, result: { ...result, spaceId: ctx.otherSpace } };
    expect(await incidentTurn(() => sink.registerToolResult!(stray))).toEqual(
      [],
    );
  });
});

it('the composed incident policy still confines an incident Dot’s controlled writes', async () => {
  const w = await world({ NEMODOTS_INCIDENT_DOT_IDS: 'incident-dot' });
  await w.within(async (ctx) => {
    const policy = getActivePolicy();
    expect(policy.isIncident('incident-dot')).toBe(true);
    expect(policy.isIncident('ordinary-dot')).toBe(false);
    // creates only in the projection Space; everything else is refused
    expect(
      policy.pageWriteAllowed({
        dotId: 'incident-dot',
        spaceId: ctx.incidentSpace,
      }),
    ).toBe(true);
    expect(
      policy.pageWriteAllowed({
        dotId: 'incident-dot',
        spaceId: ctx.otherSpace,
      }),
    ).toBe(false);
    expect(
      policy.pageWriteAllowed({
        dotId: 'ordinary-dot',
        spaceId: ctx.otherSpace,
      }),
    ).toBe(true);
    // connected-service calls and agent computer actions are refused
    expect(
      policy.connectionCall({
        dotId: 'incident-dot',
        connectionId: 'c',
        tool: 't',
      }),
    ).toEqual(expect.stringContaining('incident'));
    expect(
      policy.computerAction({
        dotId: 'incident-dot',
        action: 'exec',
        actor: 'agent',
      }),
    ).toEqual(expect.stringContaining('incident'));
    expect(
      policy.connectionCall({
        dotId: 'ordinary-dot',
        connectionId: 'c',
        tool: 't',
      }),
    ).toBeNull();
  });
});
