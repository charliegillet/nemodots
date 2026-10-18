// Route error mapping. Messages sent to the client are fixed strings or names
// of environment variables; error details (which can carry SQL, ids of other
// missions or role URLs) are never echoed.
import type { Context } from 'hono';
import { z } from 'zod';
import {
  CasConflictError,
  MissionNotFoundError,
  MissionStateError,
  ModeMismatchError,
  OpenInvalidationsError,
} from '../coordinator/errors.js';
import { ConfigVersionError } from '../sandbox/version-authority.js';

/** Inference is blocked: the 503 body names variables, never values. */
export class BlockedError extends Error {
  constructor(readonly missingEnv: string[]) {
    super('NemoDots inference is blocked.');
    this.name = 'BlockedError';
  }
}

/** The caller supplied something the route refuses (400). */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/** A server-built response failed its own contract schema. */
export class ResponseContractError extends Error {
  constructor() {
    super('response failed its contract');
    this.name = 'ResponseContractError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function handleError(error: Error, c: Context) {
  if (error instanceof BlockedError)
    return c.json(
      {
        error: 'Setup required: inference is blocked.',
        missingEnv: error.missingEnv,
      },
      503,
    );
  if (error instanceof z.ZodError)
    return c.json(
      { error: error.issues[0]?.message ?? 'Invalid request.' },
      400,
    );
  if (error instanceof BadRequestError)
    return c.json({ error: error.message }, 400);
  if (error instanceof ModeMismatchError)
    return c.json(
      { error: 'The requested mode does not match the server mode.' },
      400,
    );
  if (error instanceof NotFoundError || error instanceof MissionNotFoundError)
    return c.json({ error: 'Not found.' }, 404);
  if (error instanceof MissionStateError)
    return c.json(
      {
        error: `The mission is ${error.status}; it cannot ${error.requested}.`,
      },
      409,
    );
  if (
    error instanceof OpenInvalidationsError ||
    error instanceof CasConflictError
  )
    return c.json({ error: 'The mission changed; reload and try again.' }, 409);
  if (error instanceof ConfigVersionError) {
    if (error.code === 'stale_version')
      return c.json(
        {
          error: 'This value changed; reload the latest version.',
          currentVersion: error.currentVersion,
        },
        409,
      );
    if (error.code === 'missing_key')
      return c.json({ error: 'Not found.' }, 404);
    return c.json({ error: 'Invalid source edit.' }, 400);
  }
  return c.json({ error: 'NemoDots could not complete this request.' }, 500);
}
