// Resolution of the production entry points the acceptance suite drives.
// The suite never imports production code statically: a missing module or
// export is reported as ENTRY POINT MISSING (a FAIL), never skipped. The
// list below is the verifier's dependency contract with the builders and is
// mirrored in docs/nemodots/ACCEPTANCE_CONTRACT.md section 6.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export class EntryPointMissingError extends Error {
  constructor(
    readonly entryPoint: string,
    reason: string,
  ) {
    super(
      `ENTRY POINT MISSING: ${entryPoint} (${reason}). Required by the frozen acceptance contract (docs/nemodots/ACCEPTANCE_CONTRACT.md section 6).`,
    );
    this.name = 'EntryPointMissingError';
  }
}

/** Thrown when every entry point resolved but the verifier has not yet bound the driver to its final signature. */
export class DriverWiringPendingError extends Error {
  constructor(caseId: string, entryPoints: readonly string[]) {
    super(
      `DRIVER WIRING PENDING for ${caseId}: ${entryPoints.join(', ')} exist; the verifier must bind the acceptance driver to their signatures before this case can pass. Expectations are frozen and are not edited when wiring.`,
    );
    this.name = 'DriverWiringPendingError';
  }
}

export const ENTRY = {
  // Wave 2 ledger
  registerObservation: 'src/server/nemodots/ledger/receipts.ts#registerObservation',
  supersedeAndInvalidate: 'src/server/nemodots/ledger/invalidation.ts#supersedeAndInvalidate',
  registerWithoutClosure: 'src/server/nemodots/ledger/invalidation.ts#registerWithoutClosure',
  ledgerEdges: 'src/server/nemodots/ledger/edges.ts',
  ledgerSupport: 'src/server/nemodots/ledger/support.ts',
  recordModelCall: 'src/server/nemodots/ledger/model-calls.ts#recordModelCall',
  recordOrphanedAttempt: 'src/server/nemodots/ledger/model-calls.ts#recordOrphanedAttempt',
  // Wave 2 coordinator
  coordinatorMissions: 'src/server/nemodots/coordinator/missions.ts',
  coordinatorTasks: 'src/server/nemodots/coordinator/tasks.ts',
  coordinatorLeases: 'src/server/nemodots/coordinator/leases.ts',
  coordinatorPublish: 'src/server/nemodots/coordinator/publish.ts',
  coordinatorRecovery: 'src/server/nemodots/coordinator/recovery.ts',
  // Wave 2 sandbox
  advanceConfig: 'src/server/nemodots/sandbox/version-authority.ts#advanceConfig',
  seed: 'src/server/nemodots/sandbox/seed.ts',
  checkoutMain: 'src/server/nemodots/sandbox/checkout-main.ts',
  checkoutMigration: 'src/server/nemodots/db/migrations/0004_checkout.ts',
  injector: 'src/server/nemodots/sandbox/injector.ts',
  readers: 'src/server/nemodots/sandbox/readers.ts',
  // Wave 3 actions
  propose: 'src/server/nemodots/actions/propose.ts',
  admit: 'src/server/nemodots/actions/admit.ts',
  commit: 'src/server/nemodots/actions/commit.ts',
  dispatch: 'src/server/nemodots/actions/dispatch.ts',
  reconcile: 'src/server/nemodots/actions/reconcile.ts',
  reclaim: 'src/server/nemodots/actions/reclaim.ts',
  compensate: 'src/server/nemodots/actions/compensate.ts',
  testHooks: 'src/server/nemodots/actions/test-hooks.ts',
  // Wave 3 watcher, Wave 4-5 composition
  watcher: 'src/server/nemodots/watcher/watcher.ts',
  bootstrap: 'src/server/nemodots/bootstrap.ts#createNemoDots',
  workerMain: 'src/server/nemodots/worker-main.ts',
} as const;

export type EntryName = keyof typeof ENTRY;

function split(entryPoint: string): { file: string; name: string | null } {
  const hash = entryPoint.indexOf('#');
  return hash < 0
    ? { file: entryPoint, name: null }
    : { file: entryPoint.slice(0, hash), name: entryPoint.slice(hash + 1) };
}

/** Resolves a module (and optional named export). Throws EntryPointMissingError. */
export async function requireEntry(name: EntryName): Promise<unknown> {
  const entryPoint = ENTRY[name];
  const { file, name: exportName } = split(entryPoint);
  const absolute = resolve(APP_ROOT, file);
  if (!existsSync(absolute))
    throw new EntryPointMissingError(entryPoint, 'module file does not exist');
  const specifier = pathToFileURL(absolute).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch (error) {
    throw new EntryPointMissingError(
      entryPoint,
      `module failed to load: ${(error as Error).message}`,
    );
  }
  if (exportName === null) return mod;
  if (!(exportName in mod))
    throw new EntryPointMissingError(entryPoint, 'module has no such export');
  return mod[exportName];
}

/** Resolves every listed entry point, collecting all missing ones in one error. */
export async function requireEntries(names: readonly EntryName[]) {
  const missing: string[] = [];
  const resolved: Partial<Record<EntryName, unknown>> = {};
  for (const name of names) {
    try {
      resolved[name] = await requireEntry(name);
    } catch (error) {
      if (error instanceof EntryPointMissingError) missing.push(error.message);
      else throw error;
    }
  }
  if (missing.length) throw new Error(missing.join('\n'));
  return resolved as Record<EntryName, unknown>;
}

/** Fails the calling test until the driver is bound (never a skip). */
export async function bindOrFail(caseId: string, names: readonly EntryName[]) {
  await requireEntries(names);
  throw new DriverWiringPendingError(
    caseId,
    names.map((name) => ENTRY[name]),
  );
}
