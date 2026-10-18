// TP-67: a delegate tool call id comes from the provider and is only unique
// within the attempt that received it. The dedupe key is scoped to the
// delegating attempt: no attempt can ever be handed another's child.
import { expect, it } from 'vitest';
import {
  claimStart,
  plannedMission,
  withHarness,
  type Harness,
} from './harness.js';

const input = (overrides: Record<string, unknown> = {}) => ({
  title: 'verify the reading',
  role: 'verifier' as const,
  question: 'is the namespace reading right?',
  dependsOn: [] as never[],
  justification: 'independent check',
  dependencyVector: [] as never[],
  toolCallId: 'call_0',
  ...overrides,
});

async function two(h: Harness) {
  const planned = await plannedMission(h, [
    { role: 'investigator', capabilities: ['observe', 'delegate'] },
    { role: 'investigator', capabilities: ['observe', 'delegate'] },
  ]);
  const x = await claimStart(h, { taskId: planned.taskIds[0] });
  const y = await claimStart(h, { taskId: planned.taskIds[1] });
  return { planned, x, y };
}

const parentOf = async (h: Harness, taskId: string) =>
  (
    await h.admin.query<{ parent_id: string }>(
      'SELECT parent_id FROM coordinator.tasks WHERE id = $1',
      [taskId],
    )
  ).rows[0].parent_id;

it('the same tool call id from two tasks gives two distinct children, each under its own parent', async () => {
  await withHarness(async (h) => {
    const { x, y } = await two(h);
    const first = await h.coordinator.delegate(x.context, input());
    const second = await h.coordinator.delegate(y.context, input());
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.taskId).not.toBe(first.taskId);
    expect(await parentOf(h, first.taskId)).toBe(x.context.taskId);
    expect(await parentOf(h, second.taskId)).toBe(y.context.taskId);
  });
});

it('a redelivery from the same attempt returns its own child; the same id with another delegation is an explicit refusal', async () => {
  await withHarness(async (h) => {
    const { x } = await two(h);
    const first = await h.coordinator.delegate(x.context, input());
    const again = await h.coordinator.delegate(x.context, input());
    expect(again).toEqual({ taskId: first.taskId, created: false });
    for (const changed of [
      { question: 'a different question' },
      { title: 'a different title' },
    ])
      await expect(
        h.coordinator.delegate(x.context, input(changed)),
      ).rejects.toMatchObject({ name: 'DelegationRejectedError' });
    // nothing new was created by the refusals
    const children = await h.admin.query(
      'SELECT count(*)::int AS n FROM coordinator.tasks WHERE parent_id = $1',
      [x.context.taskId],
    );
    expect(children.rows[0].n).toBe(1);
  });
});

it("a repair attempt of the same task that emits the same id is a new delegation, not the old attempt's child", async () => {
  await withHarness(async (h) => {
    const { planned, x } = await two(h);
    const first = await h.coordinator.delegate(x.context, input());
    // the first attempt ends (lease takeover); a second attempt of the same task runs
    await h.admin.query(
      "UPDATE coordinator.task_attempts SET lease_expires_at = now() - interval '1 minute' WHERE id = $1",
      [x.context.attemptId],
    );
    await h.coordinator.reapExpired();
    const retry = await claimStart(h, { taskId: planned.taskIds[0] });
    expect(retry.context.attemptId).not.toBe(x.context.attemptId);
    const second = await h.coordinator.delegate(retry.context, input());
    expect(second.created).toBe(true);
    expect(second.taskId).not.toBe(first.taskId);
  });
});
