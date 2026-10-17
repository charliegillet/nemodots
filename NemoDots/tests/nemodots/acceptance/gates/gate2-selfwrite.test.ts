// Gate 2 item 16 (self-write classification), split out of gate1-ledger.test.ts so that file can be the single
// Gate 1 runner. It FAILS with ENTRY POINT MISSING / DRIVER WIRING PENDING until the gate 2 verifier binds it
// (g2-races/lifecycle.test.ts G2-16 is the gate 2 suite's own runner of the same oracle cases; the gate 2
// owner decides which of the two stays).
import { describe, it } from 'vitest';
import { SELF_WRITE_CASES } from '../oracle/closures.js';
import { bindOrFail, type EntryName } from '../driver/entry-points.js';

const GRAPH: EntryName[] = [
  'registerObservation',
  'supersedeAndInvalidate',
  'ledgerEdges',
  'coordinatorMissions',
  'coordinatorTasks',
  'coordinatorLeases',
  'coordinatorPublish',
  'advanceConfig',
  'checkoutMigration',
];

describe('gate 2.16: self-write classification (SELF_WRITE_CASES)', () => {
  it.each(SELF_WRITE_CASES.map((c) => [c.id, c.title] as const))(
    '%s %s',
    async (id) => {
      await bindOrFail(id, [
        ...GRAPH,
        'watcher',
        'coordinatorRecovery',
        'propose',
        'admit',
        'commit',
      ]);
    },
  );
});
