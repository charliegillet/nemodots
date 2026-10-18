import { describe, expect, it } from 'vitest';
import * as C from '../../../src/server/nemodots/contracts/index.js';
import { eventPayloads } from './fixtures.js';

const kinds = C.EventKindSchema.options;

describe('EventPayloadSchema (D4)', () => {
  it('has exactly one payload variant per EventKind', () => {
    const variantKinds = C.EventPayloadSchema.options.map(
      (option) => (option.shape.kind as { value: string }).value,
    );
    expect(variantKinds.length).toBe(kinds.length);
    expect(new Set(variantKinds).size).toBe(variantKinds.length);
    expect([...variantKinds].sort()).toEqual([...kinds].sort());
  });

  it('fixtures cover every kind', () => {
    expect(Object.keys(eventPayloads()).sort()).toEqual([...kinds].sort());
  });

  it.each(kinds)('%s: valid payload parses', (kind) => {
    const result = C.EventPayloadSchema.safeParse(eventPayloads()[kind]);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it.each(kinds)('%s: payload with a control key is rejected', (kind) => {
    const payload = { ...eventPayloads()[kind], control: { probeSecret: 'x' } };
    expect(C.EventPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it.each(kinds)('%s: payload with a prompt key is rejected', (kind) => {
    const payload = { ...eventPayloads()[kind], prompt: 'system prompt text' };
    expect(C.EventPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it('a nested control key is rejected too', () => {
    const payload = eventPayloads()['recovery.recorded'];
    const nested = {
      ...payload,
      recovery: { ...(payload.recovery as object), control: true },
    };
    expect(C.EventPayloadSchema.safeParse(nested).success).toBe(false);
    const mission = eventPayloads()['mission.created'];
    expect(
      C.EventPayloadSchema.safeParse({
        ...mission,
        mission: { ...(mission.mission as object), control: 1 },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(
      C.EventPayloadSchema.safeParse({ kind: 'mission.deleted' }).success,
    ).toBe(false);
  });

  it('task.created exposes only the documented Task fields', () => {
    const payload = eventPayloads()['task.created'];
    const task = payload.task as Record<string, unknown>;
    expect(Object.keys(task).sort()).toEqual(
      [
        'id',
        'parentId',
        'depth',
        'title',
        'role',
        'capabilities',
        'prerequisites',
        'justification',
        'createdByModelCallId',
      ].sort(),
    );
    expect(
      C.EventPayloadSchema.safeParse({
        ...payload,
        task: { ...task, question: 'q' },
      }).success,
    ).toBe(false);
  });

  it('receipt.registered never carries model_claim trust', () => {
    const payload = {
      ...eventPayloads()['receipt.registered'],
      trust: 'model_claim',
    };
    expect(C.EventPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
