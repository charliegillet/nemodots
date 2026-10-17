// Migration 0003: CHECK constraints equal the contract enums, structural
// constraints hold, and the role grants are the ones ARCHITECTURE.md section 3
// promises.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  AbortReasonSchema,
  AttemptKindSchema,
  AttemptStatusSchema,
  CapabilitySchema,
  EnvironmentSchema,
  EventKindSchema,
  FindingConfidenceSchema,
  InvalidationReasonSchema,
  MissionStatusSchema,
  ProviderModeSchema,
  ROLE_CAPABILITIES,
  RecoveryKindSchema,
  SelfWriteSchema,
  TaskOutputKindSchema,
  TaskRoleSchema,
  TaskStatusSchema,
} from '../../../../src/server/nemodots/contracts/index.js';
import { withTestDatabase } from '../../helpers/test-db.js';
import { createRolePool } from '../../../../src/server/nemodots/db/pool.js';

const ENUM_COLUMNS: [string, string, readonly string[]][] = [
  ['missions', 'environment', EnvironmentSchema.options],
  ['missions', 'mode', ProviderModeSchema.options],
  ['missions', 'status', MissionStatusSchema.options],
  ['tasks', 'role', TaskRoleSchema.options],
  ['tasks', 'status', TaskStatusSchema.options],
  ['task_attempts', 'kind', AttemptKindSchema.options],
  ['task_attempts', 'status', AttemptStatusSchema.options],
  ['task_attempts', 'abort_reason', AbortReasonSchema.options],
  ['task_outputs', 'kind', TaskOutputKindSchema.options],
  ['findings', 'confidence', FindingConfidenceSchema.options],
  ['invalidations', 'reason', InvalidationReasonSchema.options],
  ['invalidations', 'self_write', SelfWriteSchema.options],
  ['recovery_events', 'kind', RecoveryKindSchema.options],
  ['events', 'kind', EventKindSchema.options],
];

const quoted = (definition: string) =>
  [...definition.matchAll(/'([^']+)'::text/g)].map((match) => match[1]);

it('every status/kind CHECK lists exactly the contract enum members', async () => {
  await withTestDatabase(async ({ urls }) => {
    const admin = createRolePool('admin', urls.admin);
    try {
      const { rows } = await admin.query<{ tbl: string; def: string }>(
        `SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE contype = 'c' AND connamespace = 'coordinator'::regnamespace`,
      );
      for (const [table, column, options] of ENUM_COLUMNS) {
        const matching = rows.filter(
          (row) =>
            row.tbl === `coordinator.${table}` &&
            new RegExp(`\\b${column} = ANY`).test(row.def),
        );
        expect(matching, `${table}.${column}`).toHaveLength(1);
        expect(quoted(matching[0].def).sort(), `${table}.${column}`).toEqual(
          [...options].sort(),
        );
      }
      // capabilities: subset of the Capability enum ...
      const caps = rows.filter(
        (row) =>
          row.tbl === 'coordinator.tasks' &&
          /capabilities <@ ARRAY\[/.test(row.def) &&
          !/role = /.test(row.def),
      );
      expect(caps).toHaveLength(1);
      expect(quoted(caps[0].def).sort()).toEqual(
        [...CapabilitySchema.options].sort(),
      );
      // ... and of ROLE_CAPABILITIES[role] for every role.
      const perRole = rows.find((row) =>
        /role = 'investigator'.*capabilities <@/.test(row.def),
      );
      expect(perRole).toBeDefined();
      for (const role of TaskRoleSchema.options) {
        const expected = [
          ...(ROLE_CAPABILITIES[role] as readonly string[]),
        ].sort();
        const segment = perRole!.def
          .split(/ OR /)
          .find((part) => part.includes(`role = '${role}'`))!;
        expect(
          quoted(segment.replace(`'${role}'::text`, '')).sort(),
          role,
        ).toEqual(expected);
      }
    } finally {
      await admin.end();
    }
  });
});

async function violates(
  pool: pg.Pool,
  sql: string,
  params: unknown[],
  code: string,
) {
  await expect(pool.query(sql, params)).rejects.toMatchObject({ code });
}

it('structural constraints reject malformed rows', async () => {
  await withTestDatabase(async ({ urls }) => {
    const admin = createRolePool('admin', urls.admin);
    try {
      const missionId = randomUUID();
      await admin.query(
        `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider)
         VALUES ($1, 'o', 'test', 'checkout', 'g', 'fixture', 'running', '{}', '{}')`,
        [missionId],
      );
      const insertTask = (
        over: {
          id?: string;
          parent?: string | null;
          depth?: number;
          role?: string;
          caps?: string[];
          justification?: string | null;
          prereq?: string[];
        } = {},
      ) =>
        admin.query(
          `INSERT INTO coordinator.tasks (id, mission_id, parent_id, depth, ordinal, title, question, role, capabilities,
             status, generation, prerequisites, budget, justification)
           VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(ordinal) + 1, 0) FROM coordinator.tasks WHERE mission_id = $2),
             't', 'q', $5, $6::text[], 'pending', 0, $7::uuid[], '{}', $8)`,
          [
            over.id ?? randomUUID(),
            missionId,
            over.parent ?? null,
            over.depth ?? 0,
            over.role ?? 'investigator',
            over.caps ?? [],
            over.prereq ?? [],
            over.justification ?? null,
          ],
        );
      await insertTask();
      // D5: an investigator can never hold propose_config_change.
      await expect(
        insertTask({ caps: ['propose_config_change'] }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        insertTask({
          role: 'cache_specialist',
          caps: ['propose_cache_flush', 'observe'],
        }),
      ).resolves.toBeDefined();
      await expect(
        insertTask({ role: 'verifier', caps: ['propose_cache_flush'] }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        insertTask({ role: 'planner', caps: ['observe'] }),
      ).rejects.toMatchObject({ code: '23514' });
      // delegated tasks need a justification and a parent iff depth > 0
      const root = (
        await admin.query(`SELECT id FROM coordinator.tasks LIMIT 1`)
      ).rows[0].id;
      await expect(
        insertTask({ parent: root, depth: 1 }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        insertTask({ parent: root, depth: 1, justification: 'why' }),
      ).resolves.toBeDefined();
      await expect(insertTask({ depth: 1 })).rejects.toMatchObject({
        code: '23514',
      });
      // a task cannot be its own prerequisite
      const selfId = randomUUID();
      await expect(
        insertTask({ id: selfId, prereq: [selfId] }),
      ).rejects.toMatchObject({ code: '23514' });

      const attempt = (over: Record<string, unknown> = {}) => {
        const row = {
          id: randomUUID(),
          n: 1,
          kind: 'initial',
          status: 'running',
          token: 1,
          abort: null,
          repairOf: null,
          ...over,
        };
        return admin.query(
          `INSERT INTO coordinator.task_attempts (id, task_id, mission_id, n, kind, status, generation, lease_owner,
             fencing_token, lease_expires_at, lease_renewed_at, abort_reason, repair_of)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 'w', $7, now(), now(), $8, $9::jsonb)`,
          [
            row.id,
            root,
            missionId,
            row.n,
            row.kind,
            row.status,
            row.token,
            row.abort,
            row.repairOf,
          ],
        );
      };
      await attempt();
      await expect(attempt({ n: 2, token: 1 })).rejects.toMatchObject({
        code: '23505',
      }); // (task, fencing_token)
      await expect(attempt({ n: 1, token: 2 })).rejects.toMatchObject({
        code: '23505',
      }); // (task, n)
      await expect(
        attempt({ n: 2, token: 2, kind: 'repair' }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        attempt({ n: 2, token: 2, status: 'aborted' }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        attempt({ n: 2, token: 2, status: 'running', abort: 'lease_lost' }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        attempt({ n: 2, token: 2, status: 'aborted', abort: 'because' }),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        attempt({ n: 2, token: 2, status: 'aborted', abort: 'mission_paused' }),
      ).resolves.toBeDefined();
      // the trigger stamps finished_at for non-running attempts
      const stamped = await admin.query(
        `SELECT finished_at FROM coordinator.task_attempts WHERE status = 'aborted'`,
      );
      expect(stamped.rows[0].finished_at).toBeNull(); // inserts are not stamped ...
      await admin.query(
        `UPDATE coordinator.task_attempts SET status = 'expired' WHERE status = 'running'`,
      );
      const after = await admin.query(
        `SELECT finished_at FROM coordinator.task_attempts WHERE status = 'expired'`,
      );
      expect(after.rows[0].finished_at).not.toBeNull(); // ... updates are

      // outputs: usable <=> no unusable_reason, digest is 64 lowercase hex
      const output = (
        usable: boolean,
        reason: string | null,
        digest = 'a'.repeat(64),
      ) =>
        admin.query(
          `INSERT INTO coordinator.task_outputs (id, task_id, attempt_id, mission_id, kind, content, digest, usable, unusable_reason)
           VALUES ($1, $2, (SELECT id FROM coordinator.task_attempts LIMIT 1), $3, 'handoff', '{}', $4, $5, $6)`,
          [randomUUID(), root, missionId, digest, usable, reason],
        );
      await expect(output(true, 'why')).rejects.toMatchObject({
        code: '23514',
      });
      await expect(output(false, null)).rejects.toMatchObject({
        code: '23514',
      });
      await expect(output(true, null, 'XYZ')).rejects.toMatchObject({
        code: '23514',
      });
      await expect(output(false, 'invalidated:abc')).resolves.toBeDefined();

      // recovery facts are unique per (invalidation, mission, kind, task, attempt, action)
      const recovery = () =>
        admin.query(
          `INSERT INTO coordinator.recovery_events (id, invalidation_event_id, mission_id, kind, task_id, detail)
           VALUES ($1, $2, $3, 'branch_preserved', $4, 'd')`,
          [randomUUID(), 'b'.repeat(64), missionId, root],
        );
      await recovery();
      await expect(recovery()).rejects.toMatchObject({ code: '23505' });

      await violates(
        admin,
        `INSERT INTO coordinator.missions (id, owner_id, environment, resource, goal, mode, status, budgets, provider, admission_min_age_ms)
         VALUES ($1, 'o', 'test', 'checkout', 'g', 'fixture', 'created', '{}', '{}', 60001)`,
        [randomUUID()],
        '23514',
      );
      await violates(
        admin,
        `UPDATE coordinator.missions SET cancellation = '{}'::jsonb WHERE id = $1`,
        [missionId],
        '23514', // cancellation only on cancelled missions
      );
    } finally {
      await admin.end();
    }
  });
});

it('grants: app has DML (events append-only), verifier is read-only, checkout and injector see nothing, LISTEN works for app', async () => {
  await withTestDatabase(async ({ urls }) => {
    const verifier = createRolePool('verifier', urls.verifier);
    const checkout = createRolePool('checkout', urls.checkout);
    const injector = createRolePool('injector', urls.injector);
    try {
      await expect(
        verifier.query('SELECT count(*) FROM coordinator.missions'),
      ).resolves.toBeDefined();
      await expect(
        verifier.query('SELECT count(*) FROM coordinator.events'),
      ).resolves.toBeDefined();
      await expect(
        verifier.query(
          `INSERT INTO coordinator.outbox (topic, payload) VALUES ('x', '{}')`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        checkout.query('SELECT 1 FROM coordinator.missions'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        injector.query('SELECT 1 FROM coordinator.tasks'),
      ).rejects.toMatchObject({ code: '42501' });
      const listener = new pg.Client({ connectionString: urls.app });
      await listener.connect();
      await expect(
        listener.query('LISTEN nemodots_events'),
      ).resolves.toBeDefined();
      await expect(
        listener.query('LISTEN nemodots_outbox'),
      ).resolves.toBeDefined();
      await listener.end();
    } finally {
      await Promise.all([verifier.end(), checkout.end(), injector.end()]);
    }
  });
});
