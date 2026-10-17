// Child process for the concurrent-runner case. It connects to the database
// first (so the parent can see the session in pg_stat_activity), announces
// readiness through a file, waits for the parent's "go" file, and only then
// calls the production migrate(). Prints one JSON line with the result.
//
// argv: <migrate-module-path> <barrier-dir> <runner-id>
// env:  NEMODOTS_PG_URL_ADMIN
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const [modulePath, barrierDir, id] = process.argv.slice(2);
const url = process.env.NEMODOTS_PG_URL_ADMIN;
if (!modulePath || !barrierDir || !id || !url) {
  console.error('migrate-barrier-child: bad arguments');
  process.exit(2);
}

const mod = (await import(modulePath)) as {
  migrate(o: { connectionString: string }): Promise<{
    applied: string[];
    pending: string[];
    unknown: string[];
  }>;
};

const probe = new pg.Client({
  connectionString: url,
  application_name: `acc0-barrier-${id}`,
});
await probe.connect();
writeFileSync(path.join(barrierDir, `ready-${id}`), String(process.pid));
const deadline = Date.now() + 60_000;
while (!existsSync(path.join(barrierDir, 'go'))) {
  if (Date.now() > deadline) {
    console.error('migrate-barrier-child: timed out waiting for go');
    process.exit(3);
  }
  await new Promise((resolve) => setTimeout(resolve, 2));
}
try {
  const result = await mod.migrate({ connectionString: url });
  console.log(JSON.stringify({ id, ok: true, applied: result.applied }));
} catch (error) {
  console.log(
    JSON.stringify({ id, ok: false, error: (error as Error).message }),
  );
  process.exitCode = 1;
} finally {
  await probe.end();
}
