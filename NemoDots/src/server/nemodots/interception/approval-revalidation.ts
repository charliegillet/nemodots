import type {
  ApprovalRevalidationRequest,
  ApprovalVerdict,
} from './active-policy.js';

// Evidence revalidation in front of the approval callback
// (connection-routes.ts, between approvalFor and claimAction; TOOL_COVERAGE M10).
//
// Approval semantics are unchanged (1 hour TTL, single claim, payload binding).
// This only adds a question first: is the evidence the model acted on still
// current? The check itself is a port; bootstrap implements it over the
// ledger's SupportValidator.assertCurrent (a SupportError becomes a failure).
//
// An approval created without a bound vector (NULL) passes for ordinary Dots
// and is refused for incident Dots (finding I6): an incident Dot cannot
// execute on evidence nobody can check.

export type EvidenceCheck =
  | { ok: true }
  | { ok: false; receiptId?: string; detail: string };

export interface ApprovalRevalidatorOptions {
  isIncidentDot: (dotId: string) => boolean;
  /** True/false per receipt id: supported, not superseded, live revision matches. */
  checkCurrent: (receiptIds: readonly string[]) => Promise<EvidenceCheck>;
}

export function createApprovalRevalidator(options: ApprovalRevalidatorOptions) {
  return async (
    request: ApprovalRevalidationRequest,
  ): Promise<ApprovalVerdict> => {
    if (request.vector === null) {
      if (options.isIncidentDot(request.dotId))
        return {
          ok: false,
          code: 'unbound_evidence',
          message:
            'This approval request has no recorded evidence to check, so it cannot run for an incident Dot. Ask the Dot to try again.',
        };
      return { ok: true };
    }
    if (request.vector.length === 0) return { ok: true };
    const checked = await options.checkCurrent([
      ...new Set(request.vector.map((entry) => entry.receiptId)),
    ]);
    if (checked.ok) return { ok: true };
    return {
      ok: false,
      code: 'stale_evidence',
      message:
        'The evidence behind this request has changed since it was made. Nothing was run. Ask the Dot to try again.',
      receiptId: checked.receiptId,
    };
  };
}
