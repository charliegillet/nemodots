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
  /** Space a page write lands in when the call names none. */
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
  const spaceOf = (input: unknown) => {
    const value =
      input && typeof input === 'object'
        ? (input as { spaceId?: unknown }).spaceId
        : undefined;
    return typeof value === 'string' ? value : scope.defaultSpaceId;
  };
  return decideTool(
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
