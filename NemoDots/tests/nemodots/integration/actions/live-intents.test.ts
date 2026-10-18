// IntentReader.liveIntents (the coordinator's mission evaluation waits for these
// before asking for acceptance) against the real action_intents table.
import { describe, expect, it } from 'vitest';
import { admitIntent, proposeSetConfig, withEnv } from './harness.js';

describe('actions.intents.liveIntents', () => {
  it("lists a mission's live intents (proposed, admitted) and drops them once cancelled; another mission is never listed", async () => {
    await withEnv(async (env) => {
      const mine = await proposeSetConfig(env);
      const other = await proposeSetConfig(env);
      const live = (missionId: string) =>
        env.actions.intents.liveIntents!(env.app, missionId as never);

      expect(await live(mine.world.missionId)).toEqual([mine.intent.id]);
      expect(await live(other.world.missionId)).toEqual([other.intent.id]);

      await admitIntent(env, mine);
      expect(await live(mine.world.missionId)).toEqual([mine.intent.id]);

      // a cancel bumps the mission generation: the queued intents end cancelled
      await env.actions.cancelQueued(mine.world.missionId as never, 1);
      expect(await live(mine.world.missionId)).toEqual([]);
      expect(await live(other.world.missionId)).toEqual([other.intent.id]);
    });
  });

  it('is empty for a mission without intents', async () => {
    await withEnv(async (env) => {
      const sc = await proposeSetConfig(env);
      expect(
        await env.actions.intents.liveIntents!(
          env.app,
          '00000000-0000-4000-8000-000000000001' as never,
        ),
      ).toEqual([]);
      expect(sc.intent.status).toBe('proposed');
    });
  });
});
