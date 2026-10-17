// Gate 2 (admission and races) against the frozen oracle, real PostgreSQL
// connections and the actions test hooks. Same failure semantics as gate 1.
import { describe, it } from 'vitest';
import {
  ADMISSION_CASES,
  LEASE_CASES,
  type AdmissionStep,
} from '../oracle/admission.js';
import { bindOrFail, type EntryName } from '../driver/entry-points.js';

const BASE: EntryName[] = [
  'registerObservation',
  'ledgerSupport',
  'coordinatorMissions',
  'coordinatorLeases',
  'advanceConfig',
  'checkoutMigration',
  'propose',
  'admit',
  'commit',
];

function flatten(steps: readonly AdmissionStep[]): AdmissionStep[] {
  return steps.flatMap((step) =>
    step.do === 'hooked'
      ? [step, ...flatten([step.step]), ...flatten(step.during)]
      : step.do === 'hold_row_lock_then_advance'
        ? [step, ...flatten(step.whileHeld)]
        : [step],
  );
}

function needsFor(steps: readonly AdmissionStep[]): EntryName[] {
  const needs = new Set<EntryName>(BASE);
  for (const step of flatten(steps)) {
    if (
      step.do === 'hooked' ||
      step.do === 'commit_concurrent' ||
      step.do === 'crash'
    )
      needs.add('testHooks');
    if (
      step.do === 'dispatch' ||
      step.do === 'drop_redis_reply' ||
      step.do === 'advance_redis_fence'
    )
      needs.add('dispatch');
    if (
      step.do === 'reconcile' ||
      step.do === 'redis_unreachable_before_script'
    )
      needs.add('reconcile');
    if (step.do === 'reclaim') needs.add('reclaim');
    if (step.do === 'compensate') needs.add('compensate');
    if (step.do === 'cancel_mission') needs.add('coordinatorMissions');
  }
  return [...needs];
}

describe('gate 2: admission, commit, dispatch (ADMISSION_CASES)', () => {
  it.each(ADMISSION_CASES.map((c) => [c.id, c.title, c] as const))(
    '%s %s',
    async (id, _title, c) => {
      await bindOrFail(id, needsFor(c.steps));
    },
  );
});

describe('gate 2: leases and fences (LEASE_CASES)', () => {
  it.each(LEASE_CASES.map((c) => [c.id, c.title] as const))(
    '%s %s',
    async (id) => {
      await bindOrFail(id, [
        'coordinatorMissions',
        'coordinatorTasks',
        'coordinatorLeases',
        'coordinatorPublish',
        'recordOrphanedAttempt',
        'propose',
        'admit',
        'commit',
        'reclaim',
      ]);
    },
  );
});
