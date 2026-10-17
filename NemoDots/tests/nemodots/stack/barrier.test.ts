import { expect, it } from 'vitest';
import {
  barrier,
  latch,
  withTimeout,
} from '../helpers/barrier.js';

it('a latch holds waiters until opened, once', async () => {
  const gate = latch<number>();
  let seen: number | undefined;
  const waiter = gate.promise.then((value) => {
    seen = value;
  });
  await Promise.resolve();
  expect(seen).toBeUndefined();
  expect(gate.isOpen).toBe(false);
  gate.open(7);
  gate.open(9);
  await waiter;
  expect(seen).toBe(7);
  expect(gate.isOpen).toBe(true);
});

it('a barrier releases every party when the last one arrives', async () => {
  const meet = barrier(3);
  const order: string[] = [];
  const parties = ['a', 'b'].map((name) =>
    meet.arrive().then(() => order.push(name)),
  );
  await Promise.resolve();
  expect(order).toEqual([]);
  expect(meet.arrived).toBe(2);
  await meet.arrive();
  await Promise.all(parties);
  expect(order.sort()).toEqual(['a', 'b']);
  await expect(meet.arrive()).resolves.toBeUndefined();
  expect(() => barrier(0)).toThrow(RangeError);
});

it('withTimeout rejects with the label', async () => {
  await expect(
    withTimeout(new Promise(() => {}), 20, 'commit never ran'),
  ).rejects.toThrow('Timed out after 20 ms: commit never ran');
  await expect(withTimeout(Promise.resolve(1), 20, 'x')).resolves.toBe(1);
});
