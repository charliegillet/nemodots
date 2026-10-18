// Errors the team tools return to the model as structured tool results. Fence
// and support errors are NOT wrapped here: they propagate to the worker host,
// which settles the attempt (aborted, fenced, support_rejected).

export type ToolErrorCode =
  | 'unknown_tool'
  | 'invalid_json'
  | 'invalid_arguments'
  | 'capability_denied'
  | 'citation_out_of_scope'
  | 'unknown_runbook'
  | 'task_not_found'
  | 'delegation_rejected'
  | 'invalid_proposal'
  | 'unknown_model_call'
  | 'source_unavailable'
  | 'replan_unavailable';

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(`${code}: ${message}`);
    this.name = 'ToolError';
  }

  /** The text the model sees. */
  toResult(): { error: ToolErrorCode; message: string; details?: string[] } {
    return {
      error: this.code,
      message: this.message.slice(this.code.length + 2),
      ...(this.details.length > 0 ? { details: [...this.details] } : {}),
    };
  }
}

/** The attempt ran out of a server-side budget (iterations, tokens, calls). */
export class BudgetExhaustedError extends Error {
  constructor(
    readonly scope:
      'iterations' | 'task_tokens' | 'mission_tokens' | 'mission_calls',
    readonly used: number,
    readonly limit: number,
  ) {
    super(`budget exhausted: ${scope} ${used}/${limit}`);
    this.name = 'BudgetExhaustedError';
  }
}
