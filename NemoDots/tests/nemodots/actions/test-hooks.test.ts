// The barriers are inert unless NEMODOTS_TEST_HOOKS=1 and registering a
// handler without it fails (a handler can never be left behind in a live
// process). SimulatedCrash is its own error class.
import { afterEach, describe, expect, it } from 'vitest';
import {
  BARRIER_NAMES,
  SimulatedCrash,
  TestHooksDisabledError,
  barrier,
  clearBarriers,
  isSimulatedCrash,
  setBarrier,
  testHooksEnabled,
} from '../../../src/server/nemodots/actions/test-hooks.js';

const original = process.env.NEMODOTS_TEST_HOOKS;
afterEach(() => {
  clearBarriers();
  if (original === undefined) delete process.env.NEMODOTS_TEST_HOOKS;
  else process.env.NEMODOTS_TEST_HOOKS = original;
});

describe('test hooks', () => {
  it('names the five barriers of the contract', () => {
    expect([...BARRIER_NAMES]).toEqual([
      'after_preliminary_read',
      'before_lock',
      'after_lock_before_commit',
      'after_commit_before_dispatch',
      'after_effect_before_record',
    ]);
  });

  it('refuses registration and does nothing without NEMODOTS_TEST_HOOKS=1', async () => {
    delete process.env.NEMODOTS_TEST_HOOKS;
    expect(testHooksEnabled()).toBe(false);
    expect(() => setBarrier('before_lock', async () => {})).toThrow(
      TestHooksDisabledError,
    );
    await expect(
      barrier('before_lock', { actionId: 'a', stage: 'commit' }),
    ).resolves.toBeUndefined();
    process.env.NEMODOTS_TEST_HOOKS = 'true';
    expect(testHooksEnabled()).toBe(false);
  });

  it('runs a registered handler once enabled, and a handler registered earlier stays inert after disabling', async () => {
    process.env.NEMODOTS_TEST_HOOKS = '1';
    const seen: string[] = [];
    const remove = setBarrier('before_lock', (context) => {
      seen.push(`${context.stage}:${context.actionId}`);
    });
    await barrier('before_lock', { actionId: 'a1', stage: 'commit' });
    await barrier('after_effect_before_record', {
      actionId: 'a2',
      stage: 'dispatch',
    });
    expect(seen).toEqual(['commit:a1']);
    delete process.env.NEMODOTS_TEST_HOOKS;
    await barrier('before_lock', { actionId: 'a3', stage: 'commit' });
    expect(seen).toEqual(['commit:a1']);
    remove();
  });

  it('SimulatedCrash is recognisable and carries the barrier', async () => {
    process.env.NEMODOTS_TEST_HOOKS = '1';
    setBarrier('after_effect_before_record', () => {
      throw new SimulatedCrash('after_effect_before_record');
    });
    const error = await barrier('after_effect_before_record', {
      actionId: 'a',
      stage: 'dispatch',
    }).catch((e: unknown) => e);
    expect(isSimulatedCrash(error)).toBe(true);
    expect((error as SimulatedCrash).barrier).toBe(
      'after_effect_before_record',
    );
  });

  it('rejects an unknown barrier name', () => {
    process.env.NEMODOTS_TEST_HOOKS = '1';
    expect(() => setBarrier('nope' as never, null)).toThrow(RangeError);
  });
});
