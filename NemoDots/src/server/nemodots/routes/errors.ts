import { ZodError } from 'zod';
import type { BlockedResponse, ErrorResponse } from '../contracts/index.js';
import { IllegalTransitionError } from '../contracts/transitions.js';
import {
  AcceptanceInFlightError,
  AcceptanceRejectedError,
  CasConflictError,
  CoordinatorConfigError,
  MissionNotFoundError,
  MissionStateError,
  ModeMismatchError,
  OpenInvalidationsError,
  TaskNotFoundError,
} from '../coordinator/errors.js';
import { ConfigVersionError } from '../sandbox/version-authority.js';

// Typed error mapping for /api/nemodots (CONTRACTS.md section 9). Routes are
// thin: they validate, call a port and let this module decide the status.
// Messages are written here or come from typed errors that carry ids and
// statuses only; they never include env values, URLs or provider bodies.
// Unknown errors become a generic 500 and are reported to `onError` by class
// name only.

export type RouteStatus = 400 | 404 | 409 | 413 | 415 | 500 | 503;

/** An error a handler raises on purpose; status and message are public. */
export class RouteError extends Error {
  constructor(
    readonly status: RouteStatus,
    message: string,
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

/** Mission creation or start while the server mode is `blocked`: names only. */
export class BlockedError extends RouteError {
  constructor(readonly missingEnv: readonly string[]) {
    super(
      503,
      missingEnv.length
        ? `NemoDots is blocked: set ${missingEnv.join(', ')}.`
        : 'NemoDots is blocked: the inference configuration is unusable.',
    );
    this.name = 'BlockedError';
  }
}

/** The injector trigger was asked for a scenario class it does not know. */
export class UnknownScenarioError extends Error {
  constructor(readonly scenarioClass: string) {
    super('Unknown scenario class.');
    this.name = 'UnknownScenarioError';
  }
}

export interface MappedError {
  status: RouteStatus;
  body: ErrorResponse | BlockedResponse;
}

const issueSummary = (error: ZodError) => {
  const parts = error.issues.slice(0, 6).map((issue) => {
    const path = issue.path.join('.') || 'body';
    return `${path} (${issue.code})`;
  });
  return `Invalid request: ${parts.join(', ')}.`;
};

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);

const isUnavailable = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && UNAVAILABLE_CODES.has(code);
};

export function mapError(error: unknown): MappedError {
  if (error instanceof BlockedError)
    return {
      status: 503,
      body: { error: error.message, missingEnv: [...error.missingEnv] },
    };
  if (error instanceof RouteError)
    return { status: error.status, body: { error: error.message } };
  if (error instanceof ZodError)
    return { status: 400, body: { error: issueSummary(error) } };
  if (error instanceof ModeMismatchError)
    return {
      status: 400,
      body: {
        error: 'mode must equal the server mode or be omitted.',
      },
    };
  if (error instanceof UnknownScenarioError)
    return { status: 400, body: { error: error.message } };
  if (
    error instanceof MissionNotFoundError ||
    error instanceof TaskNotFoundError
  )
    return { status: 404, body: { error: error.message } };
  if (
    error instanceof MissionStateError ||
    error instanceof CasConflictError ||
    error instanceof IllegalTransitionError ||
    error instanceof OpenInvalidationsError ||
    error instanceof AcceptanceInFlightError ||
    error instanceof AcceptanceRejectedError
  )
    return { status: 409, body: { error: error.message } };
  if (error instanceof ConfigVersionError) {
    if (error.code === 'stale_version')
      return {
        status: 409,
        body: {
          error: `Version conflict: the source is at version ${error.currentVersion ?? 'unknown'}, not ${error.expectedVersion ?? 'the expected version'}.`,
        },
      };
    if (error.code === 'missing_key')
      return { status: 404, body: { error: 'Unknown config key.' } };
    return { status: 400, body: { error: 'Invalid config key or value.' } };
  }
  if (error instanceof CoordinatorConfigError)
    return {
      status: 503,
      body: { error: 'A required NemoDots component is not configured.' },
    };
  if (isUnavailable(error))
    return {
      status: 503,
      body: { error: 'A NemoDots backing service is unavailable.' },
    };
  return { status: 500, body: { error: 'Internal error.' } };
}
