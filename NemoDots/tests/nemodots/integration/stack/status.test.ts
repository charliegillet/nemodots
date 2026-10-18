// stack.mjs status must report the health of THIS instance, not of whatever
// answers on the recorded ports. Uses plain TCP listeners as the "other
// process"; no PostgreSQL or Redis of the user is contacted.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve('scripts/nemodots/stack.mjs');

function listen() {
  return new Promise<net.Server>((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
const portOf = (server: net.Server) =>
  (server.address() as net.AddressInfo).port;

async function stack(args: string[]) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith('NEMODOTS_')) delete env[name];
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [SCRIPT, ...args],
      { env },
    );
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, out: failure.stdout + failure.stderr };
  }
}

it('status exits 1 for a never-started instance whose ports another process serves', async () => {
  const instance = `ci-u${randomBytes(4).toString('hex')}`;
  const base = path.resolve('.local', instance);
  const pgServer = await listen();
  const redisServer = await listen();
  try {
    const init = await stack([
      'init',
      '--instance',
      instance,
      '--pg-port',
      String(portOf(pgServer)),
      '--redis-port',
      String(portOf(redisServer)),
      '--checkout-port',
      '45999',
    ]);
    expect(init.code).toBe(0);
    const result = await stack(['status', '--instance', instance]);
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      'postgres: down (port served by another process)',
    );
    expect(result.out).toContain(
      'redis: down (port served by another process)',
    );
    expect(result.out).not.toContain('accepting connections');
    expect(result.out).not.toContain('PONG');
  } finally {
    pgServer.close();
    redisServer.close();
    rmSync(base, { recursive: true, force: true });
  }
}, 60_000);
