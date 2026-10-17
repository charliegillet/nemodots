import type {
  ActivePolicy,
  PolicyDecision,
  ToolOrigin,
} from './active-policy.js';

// Server-side wrapper over the TanStack tool array (dot-agent.ts), the
// execution-time layer of defence in depth next to the middleware's
// onBeforeToolCall. It wraps ONLY tools that carry an executor. Client tools
// (review_space_page, request_connection_action) have no executor and are
// returned untouched: giving them one would turn them into server tools and
// break the interrupt round-trip (finding I7).

export class ToolPolicyError extends Error {
  constructor(
    readonly toolName: string,
    readonly decision: Extract<PolicyDecision, { allow: false }>,
  ) {
    super(`Refused by NemoDots policy: ${decision.reason}`);
    this.name = 'ToolPolicyError';
  }
}

interface ToolLike {
  name: string;
  execute?: ((args: any, context?: any) => any) | undefined;
}

export interface WithToolPolicyOptions {
  dotId: string;
  /** Resolved on every call so a policy installed after construction applies. */
  policy: () => ActivePolicy;
  origin?: (toolName: string) => ToolOrigin | undefined;
  onRefusal?: (info: {
    toolName: string;
    decision: Extract<PolicyDecision, { allow: false }>;
  }) => void;
}

export function withToolPolicy<T extends ToolLike>(
  tools: readonly T[],
  options: WithToolPolicyOptions,
): T[] {
  return tools.map((tool) => {
    const execute = tool.execute;
    if (!execute) return tool;
    const wrapped: T = {
      ...tool,
      execute: async (args: unknown, context?: unknown) => {
        const decision = options.policy().decideTool({
          dotId: options.dotId,
          toolName: tool.name,
          origin: options.origin?.(tool.name),
          args,
        });
        if (!decision.allow) {
          options.onRefusal?.({ toolName: tool.name, decision });
          throw new ToolPolicyError(tool.name, decision);
        }
        return execute(args, context);
      },
    };
    return wrapped;
  });
}
