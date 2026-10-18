// Wraps ONLY tools that carry a server-side executor (finding I7). Client
// tools (review_space_page, request_connection_action) have no executor and are
// returned untouched, so the approval interrupt round-trip still ends with a
// pending client tool call. For non-incident Dots the array is returned as is.
import type { AnyTool } from '@tanstack/ai';
import type { ToolPolicy } from './active-policy.js';
import { decideTool, type Refusal } from './policy-registry.js';

export interface ToolPolicyScope {
  dotId: string;
  policy: ToolPolicy;
  /**
   * The Dot's default page destination. Not a policy input: a create that names
   * no Space is refused for incident Dots, because the Space it would land in
   * (the thread's current page Space, else this default) is decided later by
   * page-tools.ts and can change between this check and the write.
   */
  defaultSpaceId: string | null;
  onRefusal?: (refusal: Refusal & { toolName: string }) => void;
}

export class ToolRefusedError extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
    this.name = 'ToolRefusedError';
  }
}

export function checkToolCall(
  scope: ToolPolicyScope,
  name: string,
  args: unknown,
): Refusal | null {
  if (!scope.policy.isIncident(scope.dotId)) return null;
  // Only an explicit Space is checked; the Space an omitted one resolves to is
  // not known here, so it is treated as no Space at all (finding TP-02).
  const spaceOf = (input: unknown) => {
    const value =
      input && typeof input === 'object'
        ? (input as { spaceId?: unknown }).spaceId
        : undefined;
    return typeof value === 'string' ? value : null;
  };
  const refusal = decideTool(
    name,
    (toolName, input) =>
      // Only creation may be allowed (into the projection Space); edits of
      // existing pages stay refused so ledger values never come from prose.
      toolName === 'create_space_page' &&
      scope.policy.pageWriteAllowed({
        dotId: scope.dotId,
        spaceId: spaceOf(input),
      }),
    args,
  );
  return refusal && name === 'create_space_page' && spaceOf(args) === null
    ? {
        ...refusal,
        message: `Tool ${name} needs an explicit spaceId in the incident scope: an omitted spaceId would land in the current page's Space, not the mission projection Space.`,
      }
    : refusal;
}

export function withToolPolicy<T extends AnyTool>(
  tools: readonly T[],
  scope: ToolPolicyScope,
): T[] {
  if (!scope.policy.isIncident(scope.dotId)) return [...tools];
  return tools.map((tool) => {
    const execute = tool.execute;
    if (!execute) return tool;
    return {
      ...tool,
      execute: (args: unknown, context?: unknown) => {
        const refusal = checkToolCall(scope, tool.name, args);
        if (refusal) {
          scope.onRefusal?.({ ...refusal, toolName: tool.name });
          throw new ToolRefusedError(refusal);
        }
        return execute(args, context);
      },
    };
  });
}
