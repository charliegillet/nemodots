import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AcceptanceInFlightError,
  CasConflictError,
  CoordinatorConfigError,
  MissionNotFoundError,
  MissionStateError,
  ModeMismatchError,
} from '../../../src/server/nemodots/coordinator/errors.js';
import { IllegalTransitionError } from '../../../src/server/nemodots/contracts/transitions.js';
import { ConfigVersionError } from '../../../src/server/nemodots/sandbox/version-authority.js';
import {
  BlockedError,
  RouteError,
  UnknownScenarioError,
  mapError,
} from '../../../src/server/nemodots/routes/errors.js';

describe('mapError', () => {
  it('maps validation failures to 400 without echoing values', () => {
    const result = z
      .object({ goal: z.string().min(3) })
      .strict()
      .safeParse({ goal: 'sk-secret-value-123', extra: 1 });
    expect(result.success).toBe(false);
    const mapped = mapError((result as { error: z.ZodError }).error);
    expect(mapped.status).toBe(400);
    expect(JSON.stringify(mapped.body)).not.toContain('sk-secret-value-123');
    expect(mapped.body.error).toMatch(/^Invalid request: /);
  });

  it('maps typed coordinator errors', () => {
    expect(mapError(new ModeMismatchError('live', 'fixture')).status).toBe(400);
    expect(mapError(new MissionNotFoundError('m')).status).toBe(404);
    expect(
      mapError(new MissionStateError('m', 'running', 'start')).status,
    ).toBe(409);
    expect(
      mapError(new CasConflictError('mission', 'm', 'created')).status,
    ).toBe(409);
    expect(
      mapError(new IllegalTransitionError('mission', 'created', 'succeeded'))
        .status,
    ).toBe(409);
    expect(mapError(new AcceptanceInFlightError('m')).status).toBe(409);
    expect(
      mapError(new CoordinatorConfigError('no probe configured')).status,
    ).toBe(503);
  });

  it('maps config version errors: stale is 409, missing key 404, bad input 400', () => {
    expect(
      mapError(new ConfigVersionError('stale_version', 'k', 'x', 1, 3)),
    ).toEqual({
      status: 409,
      body: { error: 'Version conflict: the source is at version 3, not 1.' },
    });
    expect(
      mapError(new ConfigVersionError('missing_key', 'k', 'x')).status,
    ).toBe(404);
    expect(
      mapError(new ConfigVersionError('invalid_key', 'k', 'x')).status,
    ).toBe(400);
  });

  it('BlockedError carries names only', () => {
    const mapped = mapError(new BlockedError(['OPENAI_BASE_URL']));
    expect(mapped.status).toBe(503);
    expect(mapped.body).toMatchObject({ missingEnv: ['OPENAI_BASE_URL'] });
    expect(Object.keys(mapped.body).sort()).toEqual(['error', 'missingEnv']);
  });

  it('maps RouteError and UnknownScenarioError, connection failures to 503, the rest to a generic 500', () => {
    expect(mapError(new RouteError(415, 'Use application/json.'))).toEqual({
      status: 415,
      body: { error: 'Use application/json.' },
    });
    expect(mapError(new UnknownScenarioError('nope')).status).toBe(400);
    expect(
      mapError(
        Object.assign(new Error('connect ECONNREFUSED postgres://u:pw@h/db'), {
          code: 'ECONNREFUSED',
        }),
      ),
    ).toEqual({
      status: 503,
      body: { error: 'A NemoDots backing service is unavailable.' },
    });
    const unknown = mapError(
      new Error('password authentication failed for hunter2'),
    );
    expect(unknown).toEqual({
      status: 500,
      body: { error: 'Internal error.' },
    });
  });
});
