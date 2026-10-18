// Gating of the live host: nothing starts without live credentials, a dedicated
// instance and the verifier/admin/injector roles.
import { describe, expect, it } from 'vitest';
import { HostBlockedError } from '../../../src/server/nemodots/evals/host.js';
import {
  assertInstance,
  createLiveHost,
  missingLiveEnv,
} from '../../../src/server/nemodots/evals/live-host.js';

const driver = {
  createAndStart: async () => ({ missionId: 'm' }),
  cancel: async () => {},
  close: async () => {},
};
const live = {
  OPENAI_API_KEY: 'k',
  OPENAI_BASE_URL: 'https://api.example.test/v1',
  OPENAI_MODEL: 'm',
};

describe('live host gating', () => {
  it('names exactly the missing live variables, never their values', () => {
    expect(missingLiveEnv({})).toEqual([
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
    ]);
    expect(missingLiveEnv({ ...live, OPENAI_BASE_URL: '  ' })).toEqual([
      'OPENAI_BASE_URL',
    ]);
    expect(missingLiveEnv(live)).toEqual([]);
  });

  it('refuses the shared dev instance unless explicitly allowed', () => {
    expect(() => assertInstance('dev')).toThrow(HostBlockedError);
    expect(() => assertInstance('dev', ['dev'])).not.toThrow();
    expect(() => assertInstance('ci-evals')).not.toThrow();
    try {
      assertInstance('dev');
    } catch (error) {
      expect((error as Error).message).toMatch(
        /^BLOCKED: refusing the shared dev instance/,
      );
    }
  });

  it('blocks on missing credentials before touching any database', async () => {
    await expect(createLiveHost({ env: {}, driver })).rejects.toMatchObject({
      name: 'HostBlockedError',
      missing: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'],
    });
  });

  it('blocks on the dev instance and on missing role URLs', async () => {
    await expect(
      createLiveHost({ env: { ...live, NEMODOTS_INSTANCE: 'dev' }, driver }),
    ).rejects.toThrow(/refusing the shared dev instance/);
    await expect(
      createLiveHost({
        env: { ...live, NEMODOTS_INSTANCE: 'ci-evals' },
        driver,
      }),
    ).rejects.toThrow(/NEMODOTS_PG_URL_\w+ missing/);
  });
});
