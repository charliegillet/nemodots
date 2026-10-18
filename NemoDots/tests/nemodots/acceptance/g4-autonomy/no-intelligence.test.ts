// LEAD_NOTES: NemoDots mission control, ledger, coordinator and UI must NOT
// depend on CopilotKit Intelligence and must stay honestly labelled when the
// key is absent. The app here is started without any Intelligence variable.
// (Part of TEST_PROMPT gate 4 case 8's context: a conversation outage must not
// stop incident missions.) Scripted provider: proves independence only.
import { describe, expect, it } from 'vitest';
import { G4 } from './config.js';
import { finish, launchMission, lazySystem } from './flow.js';
import { planReply, TWO_BRANCH_PLAN } from './scenarios.js';

const system = lazySystem({
  providerPort: G4.providerPort,
  script: (call) =>
    call.kind === 'structured'
      ? planReply(TWO_BRANCH_PLAN)
      : { type: 'content', text: 'done' },
});

describe('G4.8d mission control does not depend on Intelligence', () => {
  it('G4.8d health labels Intelligence blocked while a mission still starts and plans', async () => {
    const { system: sys } = await system();
    const health = await sys.api.health();
    expect(health.intelligence, 'honest badge without a key').toBe('blocked');
    const { mission, tail } = await launchMission(sys.api);
    try {
      await tail.until(
        (e) => e.some((x) => x.payload.kind === 'task.created'),
        120_000,
        'planner tasks created without Intelligence',
      );
      expect(tail.parseErrors).toEqual([]);
    } finally {
      await finish(sys.api, mission.id, tail);
    }
  }, 300_000);
});
