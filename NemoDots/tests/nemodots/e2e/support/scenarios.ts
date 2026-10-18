// The two fixture missions the populated-view suites look at. Both go through
// the real coordinator, ledger and action boundary (see seed.ts); only the
// model's part is authored.
import { digest } from '../../../../src/server/nemodots/contracts/index.js';
import type { Seeder, ServerRef } from './seed.js';

export interface ChangedEvidenceMission {
  missionId: string;
  taskIds: string[];
  actionId: string;
  memberReceiptId: string;
  /** The config revision the proposal rests on. */
  proposedFromRevision: number;
}

/**
 * A database specialist proposes raising db.pool_max on evidence it read. The
 * mission's admission delay keeps the proposal waiting, which is the window in
 * which a test (or a person) changes the same setting.
 */
export async function seedChangedEvidenceMission(
  seeder: Seeder,
  server: ServerRef,
  options: { minAgeMs: number },
): Promise<ChangedEvidenceMission> {
  const mission = await seeder.createMission(server, {
    goal: 'Restore checkout: orders are failing under load',
    constraints: [
      'Change only configuration the evidence supports.',
      'Do not flush caches.',
    ],
    admission: { minAgeMs: options.minAgeMs },
  });
  const taskIds = await seeder.publishPlan(mission, [
    {
      title: 'Find what is failing',
      question: 'Which setting or dependency explains the failing orders?',
      role: 'investigator',
      capabilities: ['observe', 'publish_finding'],
      dependsOn: [],
    },
    {
      title: 'Propose a configuration fix',
      question: 'What single configuration change would restore checkout?',
      role: 'database_specialist',
      capabilities: ['observe', 'publish_finding', 'propose_config_change'],
      dependsOn: [0],
    },
  ]);

  await seeder.runTask(mission, taskIds[0], async (step) => {
    const health = await step.observe('checkout.health');
    const pool = await step.observe('checkout.config/db.pool_max');
    const call = await step.modelCall([health, pool]);
    await step.finding({
      claim: 'The connection pool limit is the setting under suspicion.',
      supportingReceiptIds: [pool.id],
      confidence: 'medium',
      vector: call.vector,
    });
    await step.finish(
      {
        summary:
          'Checkout health was read together with the connection pool limit.',
      },
      call.vector,
    );
  });

  let actionId = '';
  let memberReceiptId = '';
  let proposedFromRevision = 0;
  await seeder.runTask(mission, taskIds[1], async (step) => {
    const pool = await step.observe('checkout.config/db.pool_max');
    const health = await step.observe('checkout.health');
    memberReceiptId = pool.id;
    proposedFromRevision = pool.sourceRevision;
    const call = await step.modelCall([pool, health]);
    const live = await step.liveConfig('db.pool_max');
    const intent = await step.propose({
      action: 'set_config',
      payload: {
        key: 'db.pool_max',
        value: 20,
        expectedCurrentValueDigest: digest(live.value),
      },
      supportingReceiptIds: [pool.id],
      rationale: 'Raise the connection pool limit from the value read.',
      call,
    });
    actionId = intent.id;
    await step.finding({
      claim: 'Raising db.pool_max is the proposed fix.',
      supportingReceiptIds: [pool.id],
      confidence: 'medium',
      vector: call.vector,
    });
    await step.finish(
      { summary: 'Proposed raising db.pool_max; waiting for admission.' },
      call.vector,
    );
  });
  return {
    missionId: mission.id,
    taskIds,
    actionId,
    memberReceiptId,
    proposedFromRevision,
  };
}

/** Two investigators read live sources and finish; the acceptance probe settles the mission. */
export async function seedHealthyMission(
  seeder: Seeder,
  server: ServerRef,
): Promise<{ missionId: string; taskIds: string[] }> {
  const mission = await seeder.createMission(server, {
    goal: 'Confirm the checkout app is healthy',
    constraints: ['Read only; propose no changes.'],
  });
  const taskIds = await seeder.publishPlan(mission, [
    {
      title: 'Read checkout health',
      question: 'Does the health endpoint report every dependency as ok?',
      role: 'investigator',
      capabilities: ['observe', 'publish_finding'],
      dependsOn: [],
    },
    {
      title: 'Read the storefront banner setting',
      question: 'Is the storefront banner configured as expected?',
      role: 'investigator',
      capabilities: ['observe', 'publish_finding'],
      dependsOn: [],
    },
  ]);
  for (const [index, key] of [
    'checkout.health',
    'checkout.config/ui.banner_text',
  ].entries())
    await seeder.runTask(mission, taskIds[index], async (step) => {
      const receipt = await step.observe(key);
      const call = await step.modelCall([receipt]);
      await step.finding({
        claim: `${key} was read and recorded as evidence.`,
        supportingReceiptIds: [receipt.id],
        confidence: 'high',
        vector: call.vector,
      });
      await step.finish({ summary: `${key} read.` }, call.vector);
    });
  return { missionId: mission.id, taskIds };
}
