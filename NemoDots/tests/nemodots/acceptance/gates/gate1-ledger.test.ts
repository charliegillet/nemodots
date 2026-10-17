// Gate 1 (ledger and lineage) against the frozen oracle. Each case resolves
// the production entry points it needs first: until they exist the case
// FAILS with ENTRY POINT MISSING; once they exist it fails with DRIVER
// WIRING PENDING until the verifier binds the driver. Expected values come
// only from ../oracle and are never edited during wiring.
import { describe, it } from 'vitest';
import {
  CLOSURE_CASES,
  REJECTION_CASES,
  SELF_WRITE_CASES,
} from '../oracle/closures.js';
import { LEDGER_CASES } from '../oracle/ledger.js';
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

describe('gate 1: registration, supersession, freshness (LEDGER_CASES)', () => {
  it.each(LEDGER_CASES.map((c) => [c.id, c.title, c] as const))(
    '%s %s',
    async (id, _title, c) => {
      const needs: EntryName[] = [
        'registerObservation',
        'ledgerSupport',
        'advanceConfig',
        'checkoutMigration',
      ];
      if (c.ops.some((op) => op.op === 'publish_finding'))
        needs.push('coordinatorPublish');
      await bindOrFail(id, needs);
    },
  );
});

describe('gate 1: hand-enumerated invalidation closures (CLOSURE_CASES)', () => {
  it.each(CLOSURE_CASES.map((c) => [c.id, c.title] as const))(
    '%s %s',
    async (id) => {
      await bindOrFail(id, GRAPH);
    },
  );
});

describe('gate 1: cycle and cap rejections (REJECTION_CASES)', () => {
  it.each(REJECTION_CASES.map((c) => [c.id, c.title, c] as const))(
    '%s %s',
    async (id, _title, c) => {
      const needs: EntryName[] =
        c.operation.kind === 'generated'
          ? [...GRAPH, 'registerWithoutClosure', 'watcher']
          : c.operation.kind === 'edge'
            ? ['ledgerEdges']
            : ['coordinatorTasks'];
      await bindOrFail(id, needs);
    },
  );
});

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
