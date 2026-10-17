// Exports per-trial evidence and the gate summary under .local/acceptance/g6/.
// The record holds no secrets: role URLs, the probe secret and tokens are never
// stored on it (leaks are recorded as labels only).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCRATCH } from './config.js';
import type { Thresholds } from './frozen.js';
import type { TrialRecord } from './record.js';
import {
  aggregate,
  scoreCrashResume,
  scoreInvariants,
  scorePreservedWork,
  scoreProvenance,
  scoreTrial,
} from './scoring.js';

export function exportTrial(record: TrialRecord, t: Thresholds): string {
  const dir = resolve(SCRATCH, 'trials');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${record.trialId}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        score: scoreTrial(record, t),
        invariants: scoreInvariants(record),
        preservedWork: scorePreservedWork(record),
        provenance: scoreProvenance(record),
        crash: scoreCrashResume(record, t),
        record,
      },
      null,
      2,
    ),
  );
  return file;
}

export function exportSummary(records: TrialRecord[], t: Thresholds): string {
  mkdirSync(SCRATCH, { recursive: true });
  const scores = records.map((r) => scoreTrial(r, t));
  const file = resolve(SCRATCH, 'g6-summary.json');
  writeFileSync(
    file,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: 'live autonomous trials only; deterministic adapter scenarios are reported separately',
        trials: records.length,
        aggregate: aggregate(scores, t),
        scores,
      },
      null,
      2,
    ),
  );
  return file;
}
