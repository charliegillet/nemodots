#!/usr/bin/env node
// NemoDots native local stack: PostgreSQL + Redis (+ the checkout API once it
// exists) under NemoDots/.local/<instance>/. Plain Node ESM, no dependencies.
//
//   node scripts/nemodots/stack.mjs <command> [--instance <name>] [--pg-port <n>]
//        [--redis-port <n>] [--checkout-port <n>]
//
//   init        create .local/<instance>/ (initdb, roles.env with generated passwords)
//   start       start PostgreSQL and Redis, ensure roles + database, spawn the checkout API
//   stop        stop what start started (only processes this script recorded)
//   status      health: pg_isready, redis PING, checkout pid; exit 1 if PostgreSQL or Redis is down
//   reset       stop, delete this instance's data, init again (requires --yes)
//   reset-test  drop leftover nemodots_test_* databases and nemodots:test:* Redis keys
//   exec -- <cmd...>   run <cmd> with roles.env and the instance's NEMODOTS_* values in its env
//   run <file> [args]  exec a repo script (tsx for .ts); exit 2 "not implemented" when absent
//   checkout [--entry <tests/nemodots/...>]  run the checkout API in the foreground with the
//               minimal explicit env (finding I3)
//
// Never prints a value from roles.env or .env. Refuses ports 5432 and 6379
// (the user's own PostgreSQL and Redis) and data directories it did not create.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const FORBIDDEN_PORTS = new Set([5432, 6379]);
const DEFAULTS = { pgPort: 55432, redisPort: 56379, checkoutPort: 4510 };
const SUPERUSER = 'nemodots_super';
const DATABASE = 'nemodots';
const ROLES = ['admin', 'app', 'checkout', 'injector', 'verifier'];
const CHECKOUT_ENTRY = 'src/server/nemodots/sandbox/checkout-main.ts';
const TEST_DB_PATTERN = /^nemodots_test_[0-9a-f]+$/;
const PG_ENV = { LC_ALL: 'C', LANG: 'C', PATH: process.env.PATH ?? '' };

class StackError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const say = (line) => console.log(`nemodots:stack ${line}`);

// ---------------------------------------------------------------- options

function parseArgs(argv) {
  const out = { command: argv[0], flags: {}, rest: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      out.rest.push(...argv.slice(i + 1));
      break;
    }
    if (out.command === 'run' && !arg.startsWith('--') && !out.rest.length) {
      out.rest.push(...argv.slice(i));
      break;
    }
    if (arg === '--yes') out.flags.yes = true;
    else if (
      [
        '--instance',
        '--pg-port',
        '--redis-port',
        '--checkout-port',
        '--entry',
      ].includes(arg)
    ) {
      const value = argv[i + 1];
      if (value === undefined) throw new StackError(`${arg} needs a value`, 2);
      out.flags[arg.slice(2)] = value;
      i += 1;
    } else throw new StackError(`unknown argument ${arg}`, 2);
  }
  return out;
}

function parsePort(name, raw) {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1 || Number(raw) > 65535)
    throw new StackError(`${name} must be a port number`, 2);
  const port = Number(raw);
  if (FORBIDDEN_PORTS.has(port))
    throw new StackError(
      `${name} ${port} is refused: ports 5432/6379 belong to the user's own PostgreSQL/Redis`,
      2,
    );
  return port;
}

function resolveContext(flags) {
  const instance = flags.instance ?? process.env.NEMODOTS_INSTANCE ?? 'dev';
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(instance))
    throw new StackError('instance must match ^[a-z0-9][a-z0-9-]{0,23}$', 2);
  const base = path.join(APP_ROOT, '.local', instance);
  const paths = {
    base,
    stack: path.join(base, 'stack'),
    meta: path.join(base, 'stack', 'instance.json'),
    roles: path.join(base, 'stack', 'roles.env'),
    pgdata: path.join(base, 'pg'),
    pgMarker: path.join(base, 'pg', 'nemodots-stack.json'),
    redis: path.join(base, 'redis'),
    run: path.join(base, 'run'),
    logs: path.join(base, 'logs'),
  };
  const socketPath = path.join(paths.run, '.s.PGSQL.65535');
  if (Buffer.byteLength(socketPath) > 100)
    throw new StackError(
      `the PostgreSQL socket path under ${paths.run} would exceed the 103-byte limit; use a shorter checkout path or instance name`,
    );
  const requested = {
    pgPort: parsePort(
      '--pg-port',
      flags['pg-port'] ?? process.env.NEMODOTS_PG_PORT,
    ),
    redisPort: parsePort(
      '--redis-port',
      flags['redis-port'] ?? process.env.NEMODOTS_REDIS_PORT,
    ),
    checkoutPort: parsePort(
      '--checkout-port',
      flags['checkout-port'] ?? process.env.NEMODOTS_CHECKOUT_PORT,
    ),
  };
  const meta = readMeta(paths);
  if (meta) {
    for (const key of Object.keys(requested)) {
      if (requested[key] !== undefined && requested[key] !== meta[key])
        throw new StackError(
          `instance ${instance} was initialised with ${key} ${meta[key]}; got ${requested[key]}. Use another --instance or reset this one`,
          2,
        );
    }
  }
  const ports = {
    pgPort: meta?.pgPort ?? requested.pgPort ?? DEFAULTS.pgPort,
    redisPort: meta?.redisPort ?? requested.redisPort ?? DEFAULTS.redisPort,
    checkoutPort:
      meta?.checkoutPort ?? requested.checkoutPort ?? DEFAULTS.checkoutPort,
  };
  for (const [key, value] of Object.entries(ports)) parsePort(key, value);
  return { instance, paths, meta, ...ports };
}

function readMeta(paths) {
  if (!fs.existsSync(paths.meta)) return undefined;
  const meta = JSON.parse(fs.readFileSync(paths.meta, 'utf8'));
  if (meta.createdBy !== 'scripts/nemodots/stack.mjs')
    throw new StackError(
      `${paths.meta} was not written by stack.mjs; refusing`,
    );
  return meta;
}

/** Refuses any instance directory whose data this script did not create. */
function assertOwned(ctx) {
  if (!ctx.meta)
    throw new StackError(
      `instance ${ctx.instance} is not initialised (run: npm run nemodots:stack -- init --instance ${ctx.instance})`,
    );
  if (fs.existsSync(path.join(ctx.paths.pgdata, 'PG_VERSION'))) {
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(ctx.paths.pgMarker, 'utf8'));
    } catch {
      marker = undefined;
    }
    if (!marker || marker.stackId !== ctx.meta.stackId)
      throw new StackError(
        `${ctx.paths.pgdata} was not created by this stack instance; refusing to touch it`,
      );
  }
}

function instanceEnv(ctx) {
  return {
    NEMODOTS_INSTANCE: ctx.instance,
    NEMODOTS_PG_HOST: '127.0.0.1',
    NEMODOTS_PG_PORT: String(ctx.pgPort),
    NEMODOTS_PG_DATABASE: DATABASE,
    NEMODOTS_REDIS_PORT: String(ctx.redisPort),
    NEMODOTS_REDIS_URL: `redis://127.0.0.1:${ctx.redisPort}/0`,
    NEMODOTS_REDIS_PREFIX: `nemodots:${ctx.instance}`,
    NEMODOTS_CHECKOUT_PORT: String(ctx.checkoutPort),
    NEMODOTS_CHECKOUT_URL: `http://127.0.0.1:${ctx.checkoutPort}`,
  };
}

function readRoles(ctx) {
  const stat = fs.statSync(ctx.paths.roles);
  if (stat.mode & 0o077)
    throw new StackError(`${ctx.paths.roles} must have mode 0600; refusing`);
  const values = {};
  for (const raw of fs.readFileSync(ctx.paths.roles, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) values[line.slice(0, i)] = line.slice(i + 1);
  }
  return values;
}

// ---------------------------------------------------------------- processes

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: options.env ?? PG_ENV,
    input: options.input,
    stdio: options.stdio,
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) throw new StackError(`${cmd}: ${result.error.message}`);
  return result;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function commandOf(pid) {
  const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function portAcceptsConnections(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function logFd(ctx, name) {
  fs.mkdirSync(ctx.paths.logs, { recursive: true });
  return fs.openSync(path.join(ctx.paths.logs, name), 'a');
}

// ---------------------------------------------------------------- secrets

const secret = (bytes) => randomBytes(bytes).toString('hex');

/** Pre-hashed SCRAM-SHA-256 verifier so no plaintext password reaches the server or its log. */
function scramVerifier(password) {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const redact = (text) =>
  String(text)
    .replace(/SCRAM-SHA-256\$[^'\s]*/g, 'SCRAM-SHA-256$<redacted>')
    .replace(/postgres(ql)?:\/\/[^\s'"]*/g, 'postgres://<redacted>');

function writeRolesFile(ctx) {
  if (fs.existsSync(ctx.paths.roles)) return false;
  const passwords = Object.fromEntries(ROLES.map((role) => [role, secret(24)]));
  const lines = [
    `# Generated by scripts/nemodots/stack.mjs init for instance ${ctx.instance}.`,
    '# Mode 0600. Loaded by npm run nemodots:* scripts. Never copy into .env, never print.',
    ...ROLES.map(
      (role) =>
        `NEMODOTS_PG_URL_${role.toUpperCase()}=postgres://nemodots_${role}:${passwords[role]}@127.0.0.1:${ctx.pgPort}/${DATABASE}`,
    ),
    `NEMODOTS_PROBE_SECRET=${secret(32)}`,
    '',
  ];
  fs.writeFileSync(ctx.paths.roles, lines.join('\n'), {
    mode: 0o600,
    flag: 'wx',
  });
  fs.chmodSync(ctx.paths.roles, 0o600);
  return true;
}

function rolePasswords(roles) {
  const passwords = {};
  for (const role of ROLES) {
    const value = roles[`NEMODOTS_PG_URL_${role.toUpperCase()}`];
    if (!value) throw new StackError(`roles.env lacks the ${role} URL`);
    passwords[role] = decodeURIComponent(new URL(value).password);
  }
  return passwords;
}

// ---------------------------------------------------------------- postgres

function psql(ctx, sql, database = 'postgres') {
  const result = run(
    'psql',
    [
      '-X',
      '-q',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      ctx.paths.run,
      '-p',
      String(ctx.pgPort),
      '-U',
      SUPERUSER,
      '-d',
      database,
      '-f',
      '-',
    ],
    { input: sql },
  );
  if (result.status !== 0)
    throw new StackError(`psql failed: ${redact(result.stderr).trim()}`);
  return result.stdout;
}

function pgRunning(ctx) {
  if (!fs.existsSync(path.join(ctx.paths.pgdata, 'PG_VERSION'))) return false;
  return run('pg_ctl', ['-D', ctx.paths.pgdata, 'status']).status === 0;
}

function writePgConf(ctx) {
  const conf = [
    '# Written by scripts/nemodots/stack.mjs start; rewritten on every start.',
    `port = ${ctx.pgPort}`,
    "listen_addresses = '127.0.0.1'",
    `unix_socket_directories = '${ctx.paths.run.replace(/'/g, "''")}'`,
    'unix_socket_permissions = 0700',
    'max_connections = 200',
    "password_encryption = 'scram-sha-256'",
    "log_statement = 'none'",
    'log_min_error_statement = panic',
    '',
  ];
  fs.writeFileSync(
    path.join(ctx.paths.pgdata, 'nemodots.conf'),
    conf.join('\n'),
  );
}

function ensureRolesAndDatabase(ctx) {
  const passwords = rolePasswords(readRoles(ctx));
  const statements = ROLES.map((role) => {
    const name = `nemodots_${role}`;
    const attrs =
      role === 'admin'
        ? 'LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION'
        : 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION';
    return [
      `DO $$ BEGIN CREATE ROLE ${name}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
      `ALTER ROLE ${name} WITH ${attrs} PASSWORD '${scramVerifier(passwords[role])}';`,
    ].join('\n');
  });
  statements.push(
    'GRANT pg_signal_backend TO nemodots_admin;',
    `SELECT 'CREATE DATABASE ${DATABASE} OWNER nemodots_admin' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${DATABASE}')\\gexec`,
  );
  psql(ctx, statements.join('\n'));
}

async function startPostgres(ctx) {
  if (pgRunning(ctx)) {
    say(`postgres: already running on 127.0.0.1:${ctx.pgPort}`);
  } else {
    if (await portAcceptsConnections(ctx.pgPort))
      throw new StackError(
        `port ${ctx.pgPort} is already in use by another process; choose --pg-port`,
      );
    writePgConf(ctx);
    const fd = logFd(ctx, 'postgres.log');
    const result = run(
      'pg_ctl',
      [
        '-D',
        ctx.paths.pgdata,
        '-l',
        path.join(ctx.paths.logs, 'postgres.log'),
        '-w',
        '-t',
        '60',
        'start',
      ],
      { stdio: ['ignore', fd, fd] },
    );
    fs.closeSync(fd);
    if (result.status !== 0)
      throw new StackError(
        `pg_ctl start failed (exit ${result.status}); see ${path.join(ctx.paths.logs, 'postgres.log')}`,
      );
    say(`postgres: started on 127.0.0.1:${ctx.pgPort}`);
  }
  ensureRolesAndDatabase(ctx);
}

function stopPostgres(ctx) {
  if (!pgRunning(ctx)) {
    say('postgres: not running');
    return;
  }
  const result = run('pg_ctl', [
    '-D',
    ctx.paths.pgdata,
    '-m',
    'fast',
    '-w',
    '-t',
    '60',
    'stop',
  ]);
  if (result.status !== 0)
    throw new StackError(`pg_ctl stop failed: ${redact(result.stderr).trim()}`);
  say('postgres: stopped');
}

// ---------------------------------------------------------------- redis

const redisPidFile = (ctx) => path.join(ctx.paths.run, 'redis.pid');

function ownRedisPid(ctx) {
  if (!fs.existsSync(redisPidFile(ctx))) return undefined;
  const pid = Number(fs.readFileSync(redisPidFile(ctx), 'utf8').trim());
  if (!pid || !pidAlive(pid)) return undefined;
  const command = commandOf(pid);
  return command.includes('redis-server') &&
    command.includes(`:${ctx.redisPort}`)
    ? pid
    : undefined;
}

function redisCli(ctx, args, input) {
  return run(
    'redis-cli',
    ['-h', '127.0.0.1', '-p', String(ctx.redisPort), ...args],
    { input, env: PG_ENV, timeout: 30_000 },
  );
}

async function startRedis(ctx) {
  if (ownRedisPid(ctx)) {
    say(`redis: already running on 127.0.0.1:${ctx.redisPort}`);
    return;
  }
  if (await portAcceptsConnections(ctx.redisPort))
    throw new StackError(
      `port ${ctx.redisPort} is already in use by another process; choose --redis-port`,
    );
  fs.mkdirSync(ctx.paths.redis, { recursive: true });
  const result = run('redis-server', [
    '--port',
    String(ctx.redisPort),
    '--bind',
    '127.0.0.1',
    '--protected-mode',
    'yes',
    '--save',
    '',
    '--appendonly',
    'no',
    '--daemonize',
    'yes',
    '--pidfile',
    redisPidFile(ctx),
    '--logfile',
    path.join(ctx.paths.logs, 'redis.log'),
    '--dir',
    ctx.paths.redis,
  ]);
  if (result.status !== 0)
    throw new StackError(
      `redis-server failed to start (exit ${result.status})`,
    );
  const ready = await waitFor(
    () => redisCli(ctx, ['ping']).stdout.trim() === 'PONG',
    10_000,
  );
  if (!ready)
    throw new StackError(
      `redis did not answer PING; see ${path.join(ctx.paths.logs, 'redis.log')}`,
    );
  say(`redis: started on 127.0.0.1:${ctx.redisPort}`);
}

async function stopRedis(ctx) {
  const pid = ownRedisPid(ctx);
  if (!pid) {
    say('redis: not running');
    return;
  }
  redisCli(ctx, ['shutdown', 'nosave']);
  if (!(await waitFor(() => !pidAlive(pid), 10_000))) {
    process.kill(pid, 'SIGTERM');
    if (!(await waitFor(() => !pidAlive(pid), 5_000)))
      throw new StackError(`redis (pid ${pid}) did not stop`);
  }
  fs.rmSync(redisPidFile(ctx), { force: true });
  say('redis: stopped');
}

// ---------------------------------------------------------------- checkout

const checkoutPidFile = (ctx) => path.join(ctx.paths.run, 'checkout.json');

/**
 * The checkout API's complete environment (finding I3): exactly its own role
 * URL, Redis, its port, the probe secret, LC_ALL and PATH. Never the whole
 * roles.env and never the parent's environment.
 */
function checkoutEnv(ctx) {
  const roles = readRoles(ctx);
  const values = instanceEnv(ctx);
  return {
    NEMODOTS_PG_URL_CHECKOUT: roles.NEMODOTS_PG_URL_CHECKOUT,
    NEMODOTS_REDIS_URL: values.NEMODOTS_REDIS_URL,
    NEMODOTS_REDIS_PREFIX: values.NEMODOTS_REDIS_PREFIX,
    NEMODOTS_CHECKOUT_PORT: values.NEMODOTS_CHECKOUT_PORT,
    NEMODOTS_PROBE_SECRET: roles.NEMODOTS_PROBE_SECRET,
    LC_ALL: 'C',
    PATH: process.env.PATH ?? '',
  };
}

function resolveCheckoutEntry(flags) {
  if (!flags.entry) return path.join(APP_ROOT, CHECKOUT_ENTRY);
  const entry = path.resolve(APP_ROOT, flags.entry);
  const allowed = path.join(APP_ROOT, 'tests', 'nemodots') + path.sep;
  if (!entry.startsWith(allowed) || !fs.existsSync(entry))
    throw new StackError(
      '--entry must name an existing file under tests/nemodots/',
      2,
    );
  return entry;
}

const nodeArgs = (entry) =>
  entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry];

function ownCheckout(ctx) {
  if (!fs.existsSync(checkoutPidFile(ctx))) return undefined;
  const record = JSON.parse(fs.readFileSync(checkoutPidFile(ctx), 'utf8'));
  if (!record.pid || !pidAlive(record.pid)) return undefined;
  return commandOf(record.pid).includes(record.entry) ? record : undefined;
}

async function startCheckout(ctx) {
  const entry = path.join(APP_ROOT, CHECKOUT_ENTRY);
  if (!fs.existsSync(entry)) {
    say(`checkout: skipped (${CHECKOUT_ENTRY} does not exist yet)`);
    return;
  }
  if (ownCheckout(ctx)) {
    say(`checkout: already running on 127.0.0.1:${ctx.checkoutPort}`);
    return;
  }
  if (await portAcceptsConnections(ctx.checkoutPort))
    throw new StackError(
      `port ${ctx.checkoutPort} is already in use by another process; choose --checkout-port`,
    );
  const fd = logFd(ctx, 'checkout.log');
  const child = spawn(process.execPath, nodeArgs(entry), {
    cwd: APP_ROOT,
    env: checkoutEnv(ctx),
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  child.unref();
  fs.writeFileSync(
    checkoutPidFile(ctx),
    JSON.stringify({ pid: child.pid, entry }),
  );
  const ready = await waitFor(
    async () =>
      !pidAlive(child.pid) || (await portAcceptsConnections(ctx.checkoutPort)),
    20_000,
  );
  if (!ready || !pidAlive(child.pid))
    throw new StackError(
      `checkout API did not start; see ${path.join(ctx.paths.logs, 'checkout.log')}`,
    );
  say(`checkout: started on 127.0.0.1:${ctx.checkoutPort} (pid ${child.pid})`);
}

async function stopCheckout(ctx) {
  const record = ownCheckout(ctx);
  if (!record) {
    fs.rmSync(checkoutPidFile(ctx), { force: true });
    say('checkout: not running');
    return;
  }
  process.kill(record.pid, 'SIGTERM');
  if (!(await waitFor(() => !pidAlive(record.pid), 8_000))) {
    process.kill(record.pid, 'SIGKILL');
    await waitFor(() => !pidAlive(record.pid), 3_000);
  }
  fs.rmSync(checkoutPidFile(ctx), { force: true });
  say('checkout: stopped');
}

// ---------------------------------------------------------------- commands

async function init(ctx) {
  if (ctx.meta && fs.existsSync(path.join(ctx.paths.pgdata, 'PG_VERSION'))) {
    assertOwned(ctx);
    say(`init: instance ${ctx.instance} already initialised`);
    return 0;
  }
  if (
    !ctx.meta &&
    fs.existsSync(ctx.paths.base) &&
    fs.readdirSync(ctx.paths.base).length
  )
    throw new StackError(
      `${ctx.paths.base} exists and was not created by stack.mjs; refusing`,
    );
  for (const dir of [
    ctx.paths.base,
    ctx.paths.stack,
    ctx.paths.logs,
    ctx.paths.redis,
  ])
    fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(ctx.paths.run, { recursive: true, mode: 0o700 });
  fs.chmodSync(ctx.paths.run, 0o700);
  fs.chmodSync(ctx.paths.stack, 0o700);
  const meta = ctx.meta ?? {
    createdBy: 'scripts/nemodots/stack.mjs',
    instance: ctx.instance,
    stackId: secret(8),
    createdAt: new Date().toISOString(),
    pgPort: ctx.pgPort,
    redisPort: ctx.redisPort,
    checkoutPort: ctx.checkoutPort,
    database: DATABASE,
  };
  if (!ctx.meta)
    fs.writeFileSync(ctx.paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  ctx.meta = meta;
  // A previous init of this (owned) instance may have stopped half-way.
  fs.rmSync(ctx.paths.pgdata, { recursive: true, force: true });
  const fd = logFd(ctx, 'initdb.log');
  const result = run(
    'initdb',
    [
      '-D',
      ctx.paths.pgdata,
      '-U',
      SUPERUSER,
      '--auth-local=trust',
      '--auth-host=scram-sha-256',
      '--locale=C',
      '--encoding=UTF8',
      '--no-instructions',
    ],
    { stdio: ['ignore', fd, fd] },
  );
  fs.closeSync(fd);
  if (result.status !== 0)
    throw new StackError(
      `initdb failed (exit ${result.status}); see ${path.join(ctx.paths.logs, 'initdb.log')}`,
    );
  fs.writeFileSync(
    ctx.paths.pgMarker,
    `${JSON.stringify({ stackId: meta.stackId, instance: ctx.instance })}\n`,
  );
  fs.writeFileSync(
    path.join(ctx.paths.pgdata, 'pg_hba.conf'),
    [
      '# Written by scripts/nemodots/stack.mjs: socket (0700 dir) trusted, TCP requires SCRAM.',
      'local all all trust',
      'host all all 127.0.0.1/32 scram-sha-256',
      'host all all ::1/128 scram-sha-256',
      '',
    ].join('\n'),
  );
  fs.appendFileSync(
    path.join(ctx.paths.pgdata, 'postgresql.conf'),
    "\ninclude_if_exists = 'nemodots.conf'\n",
  );
  const created = writeRolesFile(ctx);
  say(
    `init: instance ${ctx.instance} ready (postgres ${ctx.pgPort}, redis ${ctx.redisPort}, checkout ${ctx.checkoutPort}); roles.env ${created ? 'generated' : 'kept'} (0600)`,
  );
  return 0;
}

async function start(ctx) {
  assertOwned(ctx);
  if (!fs.existsSync(path.join(ctx.paths.pgdata, 'PG_VERSION')))
    throw new StackError(
      `instance ${ctx.instance} has no database cluster; run init`,
    );
  await startPostgres(ctx);
  await startRedis(ctx);
  await startCheckout(ctx);
  return 0;
}

async function stop(ctx) {
  assertOwned(ctx);
  await stopCheckout(ctx);
  await stopRedis(ctx);
  stopPostgres(ctx);
  return 0;
}

async function status(ctx) {
  assertOwned(ctx);
  // Health must belong to THIS instance: a recorded port answering is not
  // enough when another instance (or process) serves it. Postgres is checked
  // through pg_ctl on our own data dir and pg_isready on our own socket dir;
  // Redis through our own pid file before PING.
  const pgOwn = pgRunning(ctx);
  const pgReady =
    pgOwn &&
    run('pg_isready', [
      '-h',
      ctx.paths.run,
      '-p',
      String(ctx.pgPort),
      '-t',
      '5',
    ]).status === 0;
  const pgOk = pgReady;
  const pgForeign = !pgOwn && (await portAcceptsConnections(ctx.pgPort));
  say(
    `postgres: ${pgOk ? 'accepting connections' : pgForeign ? 'down (port served by another process)' : 'down'} on 127.0.0.1:${ctx.pgPort}`,
  );
  const redisOwn = Boolean(ownRedisPid(ctx));
  const redisOk = redisOwn && redisCli(ctx, ['ping']).stdout.trim() === 'PONG';
  const redisForeign =
    !redisOwn && (await portAcceptsConnections(ctx.redisPort));
  say(
    `redis: ${redisOk ? 'PONG' : redisForeign ? 'down (port served by another process)' : 'down'} on 127.0.0.1:${ctx.redisPort}`,
  );
  let checkoutOk = true;
  if (fs.existsSync(path.join(APP_ROOT, CHECKOUT_ENTRY))) {
    const record = ownCheckout(ctx);
    checkoutOk =
      Boolean(record) && (await portAcceptsConnections(ctx.checkoutPort));
    say(
      `checkout: ${checkoutOk ? `running (pid ${record.pid})` : 'down'} on 127.0.0.1:${ctx.checkoutPort}`,
    );
  } else say(`checkout: not present (${CHECKOUT_ENTRY} does not exist yet)`);
  return pgOk && redisOk && checkoutOk ? 0 : 1;
}

async function reset(ctx, flags) {
  assertOwned(ctx);
  if (!flags.yes)
    throw new StackError(
      `reset deletes ${ctx.paths.base} (database, Redis dir, logs, roles.env); pass --yes`,
      2,
    );
  await stop(ctx);
  const keep = { ...ctx.meta };
  fs.rmSync(ctx.paths.base, { recursive: true, force: true });
  say(`reset: removed ${ctx.paths.base}`);
  return init({
    ...ctx,
    meta: undefined,
    pgPort: keep.pgPort,
    redisPort: keep.redisPort,
    checkoutPort: keep.checkoutPort,
  });
}

async function resetTest(ctx) {
  assertOwned(ctx);
  if (!pgRunning(ctx))
    throw new StackError('postgres is not running; start the stack first');
  const names = psql(
    ctx,
    "SELECT datname FROM pg_database WHERE datname LIKE 'nemodots\\_test\\_%' ORDER BY 1;",
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => TEST_DB_PATTERN.test(name));
  for (const name of names)
    psql(ctx, `DROP DATABASE IF EXISTS ${name} WITH (FORCE);`);
  let keys = 0;
  if (ownRedisPid(ctx)) {
    const scan = redisCli(ctx, ['--scan', '--pattern', 'nemodots:test:*']);
    const list = scan.stdout.split('\n').filter(Boolean);
    for (let i = 0; i < list.length; i += 500) {
      redisCli(ctx, ['unlink', ...list.slice(i, i + 500)]);
    }
    keys = list.length;
  }
  say(
    `reset-test: dropped ${names.length} test databases, unlinked ${keys} test keys`,
  );
  return 0;
}

function execWithEnv(ctx, command, args) {
  assertOwned(ctx);
  if (!command) throw new StackError('exec needs a command after --', 2);
  const env = { ...process.env, ...readRoles(ctx), ...instanceEnv(ctx) };
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: APP_ROOT,
      env,
      stdio: 'inherit',
    });
    const forward = (signal) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.once('error', (error) =>
      reject(new StackError(`${command}: ${error.message}`)),
    );
    child.once('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

function runScript(ctx, rest) {
  const [file, ...args] = rest;
  if (!file) throw new StackError('run needs a script path', 2);
  const resolved = path.resolve(APP_ROOT, file);
  if (!resolved.startsWith(APP_ROOT + path.sep))
    throw new StackError(
      'run only executes files inside the NemoDots checkout',
      2,
    );
  if (!fs.existsSync(resolved)) {
    console.error(
      `nemodots:stack run: not implemented yet: ${file} does not exist (delivered by a later wave)`,
    );
    return 2;
  }
  return execWithEnv(ctx, process.execPath, [...nodeArgs(resolved), ...args]);
}

async function checkoutForeground(ctx, flags) {
  assertOwned(ctx);
  const entry = resolveCheckoutEntry(flags);
  if (!fs.existsSync(entry)) {
    console.error(
      `nemodots:stack checkout: not implemented yet: ${CHECKOUT_ENTRY} does not exist (delivered by W2)`,
    );
    return 2;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs(entry), {
      cwd: APP_ROOT,
      env: checkoutEnv(ctx),
      stdio: 'inherit',
    });
    const forward = (signal) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

const COMMANDS = {
  init: (ctx) => init(ctx),
  start: (ctx) => start(ctx),
  stop: (ctx) => stop(ctx),
  status: (ctx) => status(ctx),
  reset: (ctx, args) => reset(ctx, args.flags),
  'reset-test': (ctx) => resetTest(ctx),
  exec: (ctx, args) => execWithEnv(ctx, args.rest[0], args.rest.slice(1)),
  run: (ctx, args) => runScript(ctx, args.rest),
  checkout: (ctx, args) => checkoutForeground(ctx, args.flags),
};

async function main(argv) {
  const args = parseArgs(argv);
  const handler = COMMANDS[args.command];
  if (!handler)
    throw new StackError(
      `usage: stack.mjs <${Object.keys(COMMANDS).join('|')}> [--instance <name>] [--pg-port <n>] [--redis-port <n>] [--checkout-port <n>]`,
      2,
    );
  const ctx = resolveContext(args.flags);
  return handler(ctx, args);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 0),
    (error) => {
      console.error(`nemodots:stack error: ${redact(error.message)}`);
      process.exit(error instanceof StackError ? error.code : 1);
    },
  );
}
