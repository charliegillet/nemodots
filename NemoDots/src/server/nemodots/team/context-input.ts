// Builds the compiler input for one call. Everything model-visible goes through
// context/compile.ts: one system string, evidence and tool results wrapped as
// untrusted data, the volatile time last. Repair attempts never receive an old
// transcript: they start from an empty history, fresh reads and the
// invalidation summary.
import { randomUUID } from 'node:crypto';
import {
  unionDependencyVectors,
  type ContextLayout,
  type ContextSnapshotId,
  type DependencyEntry,
  type TeamToolName,
} from '../contracts/index.js';
import {
  compileContext,
  type CompiledContext,
  type HistoryItemInput,
  type InheritedArtifactInput,
  type InvalidationInput,
} from '../context/index.js';
import type { ContextReceipt } from '../context/index.js';
import type { ClaimedAttempt } from '../coordinator/types.js';
import {
  COMMON_INSTRUCTIONS,
  REPAIR_NOTICE,
  roleInstructions,
} from './prompts.js';
import type { TeamDeps } from './types.js';

export interface BuildInput {
  deps: TeamDeps;
  claimed: ClaimedAttempt;
  history: readonly HistoryItemInput[];
  receipts?: readonly ContextReceipt[];
  artifacts?: readonly InheritedArtifactInput[];
  invalidations?: readonly InvalidationInput[];
  readSetVector?: readonly DependencyEntry[];
  extraRoleText?: string;
  /** Last iteration: no tools are offered. */
  noTools?: boolean;
  task?: { title: string; question: string };
  layout?: ContextLayout;
  toolNames?: readonly TeamToolName[];
}

export function buildContext(input: BuildInput): CompiledContext {
  const { deps, claimed } = input;
  const repair = claimed.attempt.repairOf !== null;
  const role = [
    roleInstructions(claimed.context.role),
    repair ? REPAIR_NOTICE : '',
    `Capabilities granted to this task: ${claimed.context.capabilities.join(', ') || '(none)'}. A tool that needs a capability you lack is refused with capability_denied.`,
    input.extraRoleText ?? '',
  ]
    .filter((part) => part !== '')
    .join('\n');
  return compileContext({
    snapshotId: (deps.ids?.() ?? randomUUID()) as ContextSnapshotId,
    layout: input.layout ?? 'cache_aware',
    nowIso: (deps.clock?.() ?? new Date()).toISOString(),
    commonInstructions: COMMON_INSTRUCTIONS,
    roleInstructions: role,
    toolNames: input.noTools ? [] : input.toolNames,
    mission: {
      goal: claimed.mission.goal,
      constraints: claimed.mission.constraints,
    },
    task: input.task ?? {
      title: claimed.task.title,
      question: claimed.task.question,
    },
    runbooks: deps.runbooks.all(),
    receipts: input.receipts ?? [],
    inheritedArtifacts: input.artifacts ?? [],
    pageSnapshots: [],
    memories: [],
    invalidations: input.invalidations ?? [],
    history: input.history,
    readSetVector: input.readSetVector ?? [],
    inheritedVector: unionDependencyVectors(
      claimed.attempt.inheritedDependencyVector,
    ),
  });
}
