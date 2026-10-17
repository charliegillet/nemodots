import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as C from '../../../src/server/nemodots/contracts/index.js';
import { ids } from './fixtures.js';

const sha = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('canonical digest', () => {
  it.each([
    [{ b: 1, a: [true, null, 'x'] }, '{"a":[true,null,"x"],"b":1}'],
    [{ z: { y: 2, x: 1 } }, '{"z":{"x":1,"y":2}}'],
    [{ a: undefined, b: 1 }, '{"b":1}'],
    [[1.5, -0, 1e21, 0.1], '[1.5,0,1e+21,0.1]'],
    ['café', JSON.stringify('café')],
    [{ é: 1 }, `{${JSON.stringify('é')}:1}`],
    [{ B: 1, a: 2, _: 3 }, '{"B":1,"_":3,"a":2}'],
  ])('canonicalJson(%j)', (value, text) => {
    expect(C.canonicalJson(value)).toBe(text);
  });

  it('is stable across key order and whitespace', () => {
    const a = JSON.parse('{ "x": 1,\n  "y": { "b": [1, 2], "a": "s" } }');
    const b = JSON.parse('{"y":{"a":"s","b":[1,2]},"x":1}');
    expect(C.digest(a)).toBe(C.digest(b));
    expect(C.digest(a)).toBe(sha('{"x":1,"y":{"a":"s","b":[1,2]}}'));
    expect(C.digest(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [{ x: 2, y: { a: 's', b: [1, 2] } }],
    [{ x: 1, y: { a: 'S', b: [1, 2] } }],
    [{ x: 1, y: { a: 's', b: [2, 1] } }],
    [{ x: 1, y: { a: 's', b: [1, 2], c: null } }],
    [{ x: '1', y: { a: 's', b: [1, 2] } }],
  ])('changes on any value change (%j)', (changed) => {
    expect(C.digest(changed)).not.toBe(
      C.digest({ x: 1, y: { a: 's', b: [1, 2] } }),
    );
  });

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [{ a: 1n }],
    [[undefined]],
    [new Map()],
    [undefined],
    [{ f: () => 1 }],
  ])('rejects non-JSON input %#', (value) => {
    expect(() => C.canonicalJson(value)).toThrow(C.CanonicalJsonError);
  });

  it('rejects cycles and NFC key collisions', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => C.canonicalJson(cyclic)).toThrow(C.CanonicalJsonError);
    expect(() => C.canonicalJson({ é: 1, é: 2 })).toThrow(/duplicate key/);
  });

  it('applies toJSON (Date) like JSON.stringify', () => {
    const at = new Date('2026-10-17T18:00:00.000Z');
    expect(C.canonicalJson({ at })).toBe('{"at":"2026-10-17T18:00:00.000Z"}');
  });

  it('counts canonical bytes in UTF-8', () => {
    expect(C.canonicalByteLength('é')).toBe(4);
  });
});

describe('idempotencyKey (C5)', () => {
  const m = C.MissionIdSchema.parse(ids.mission);
  const t = C.TaskIdSchema.parse(ids.task);
  const a = C.AttemptIdSchema.parse(ids.attempt);
  const key = (toolCallId: string, version = 3) =>
    C.idempotencyKey(m, t, a, 'set_config', version, toolCallId);

  it('is deterministic', () => {
    expect(key('call_1')).toBe(key('call_1'));
    expect(key('call_1')).toMatch(/^[0-9a-f]{64}$/);
    expect(C.DigestSchema.safeParse(key('call_1')).success).toBe(true);
  });

  it('differs for a different toolCallId with an identical payload', () => {
    expect(key('call_1')).not.toBe(key('call_2'));
  });

  it('differs for every other component', () => {
    const base = key('call_1');
    expect(key('call_1', 4)).not.toBe(base);
    expect(
      C.idempotencyKey(m, t, a, 'flush_cache_namespace', 3, 'call_1'),
    ).not.toBe(base);
    expect(
      C.idempotencyKey(
        C.MissionIdSchema.parse(ids.mission2),
        t,
        a,
        'set_config',
        3,
        'call_1',
      ),
    ).not.toBe(base);
    expect(
      C.idempotencyKey(
        m,
        C.TaskIdSchema.parse(ids.task2),
        a,
        'set_config',
        3,
        'call_1',
      ),
    ).not.toBe(base);
    expect(
      C.idempotencyKey(
        m,
        t,
        C.AttemptIdSchema.parse(ids.attempt2),
        'set_config',
        3,
        'call_1',
      ),
    ).not.toBe(base);
  });

  it('does not depend on the payload (payloadHash is bound beside it)', () => {
    expect(C.idempotencyKey.length).toBe(6);
  });

  it('rejects invalid components', () => {
    expect(() => key('')).toThrow(RangeError);
    expect(() => key('call_1', -1)).toThrow(RangeError);
    expect(() => key('call_1', 1.5)).toThrow(RangeError);
  });
});

describe('invalidationEventId', () => {
  const sk = C.SourceKeySchema.parse('checkout.config/db.pool_max');
  const r1 = C.ReceiptIdSchema.parse(ids.receipt);
  const r2 = C.ReceiptIdSchema.parse(ids.receipt2);
  it('is deterministic and distinguishes null and reason', () => {
    const id = C.invalidationEventId(sk, r1, r2, 'newer_observation');
    expect(C.invalidationEventId(sk, r1, r2, 'newer_observation')).toBe(id);
    expect(C.InvalidationEventIdSchema.safeParse(id).success).toBe(true);
    expect(C.invalidationEventId(sk, r1, null, 'newer_observation')).not.toBe(
      id,
    );
    expect(C.invalidationEventId(sk, r1, r2, 'expiry')).not.toBe(id);
  });
});

describe('source keys', () => {
  it.each([
    ['checkout.config', 'checkout.config'],
    ['checkout.config/db.pool_max', 'checkout.config/<key>'],
    ['checkout.health', 'checkout.health'],
    ['checkout.metrics', 'checkout.metrics'],
    ['checkout.inventory/PROBE-SKU', 'checkout.inventory/<sku>'],
    ['checkout.orders.recent', 'checkout.orders.recent'],
    ['checkout.acceptance', 'checkout.acceptance'],
    ['redis.stats', 'redis.stats'],
    ['runbook/cache-recovery', 'runbook/<id>'],
    ['opendots.page/abc123', 'opendots.page/<pageId>'],
    ['opendots.memory/m_1', 'opendots.memory/<memoryId>'],
  ])('%s is a %s key', (key, family) => {
    expect(C.sourceKeyFamily(key)).toBe(family);
    expect(C.SourceKeySchema.safeParse(key).success).toBe(true);
  });

  it.each([
    'checkout.config/',
    'checkout.config/DB',
    'checkout.config/../x',
    'checkout.inventory/a/b',
    'runbook/../../etc/passwd',
    'runbook/.hidden',
    'checkout.healthz',
    'postgres.admin',
    '',
  ])('rejects %j', (key) => {
    expect(C.sourceKeyFamily(key)).toBeNull();
    expect(C.SourceKeySchema.safeParse(key).success).toBe(false);
  });

  it('source identity is the (ownerId, environment, resource, key) tuple', () => {
    const base = {
      key: C.SourceKeySchema.parse('checkout.health'),
      scope: {
        ownerId: 'owner',
        missionId: C.MissionIdSchema.parse(ids.mission),
        spaceId: null,
        environment: 'test' as const,
        resource: 'checkout',
      },
    };
    const other = {
      ...base,
      scope: {
        ...base.scope,
        missionId: C.MissionIdSchema.parse(ids.mission2),
      },
    };
    expect(C.sourceIdentity(other)).toBe(C.sourceIdentity(base));
    expect(
      C.sourceIdentity({
        ...base,
        scope: { ...base.scope, environment: 'eval' },
      }),
    ).not.toBe(C.sourceIdentity(base));
  });
});
