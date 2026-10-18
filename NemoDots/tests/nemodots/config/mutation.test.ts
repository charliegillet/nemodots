import { describe, expect, it } from 'vitest';
import {
  MUTATIONS,
  MutationConfigError,
  parseMutation,
} from '../../../src/server/nemodots/config/mutation.js';

const LIVE = {
  NEMODOTS_INFERENCE_MODE: 'live',
  OPENAI_BASE_URL: 'https://api.inference.crusoecloud.com/v1',
  OPENAI_MODEL: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B',
  OPENAI_API_KEY: 'k-not-a-secret-for-the-test',
};

describe('NEMODOTS_MUTATION', () => {
  it('is inert when unset or empty', () => {
    expect(parseMutation({})).toBeNull();
    expect(parseMutation({ NEMODOTS_MUTATION: '  ' })).toBeNull();
  });

  it.each(MUTATIONS)(
    '%s is honoured only with NEMODOTS_TEST_HOOKS=1',
    (name) => {
      expect(
        parseMutation({
          NEMODOTS_MUTATION: name,
          NEMODOTS_TEST_HOOKS: '1',
          NEMODOTS_INFERENCE_MODE: 'fixture',
          NEMODOTS_FIXTURE_PATH: 'x.json',
        }),
      ).toBe(name);
      expect(() => parseMutation({ NEMODOTS_MUTATION: name })).toThrow(
        MutationConfigError,
      );
    },
  );

  it('refuses an unknown name instead of ignoring it', () => {
    expect(() =>
      parseMutation({
        NEMODOTS_MUTATION: 'weaken_everything',
        NEMODOTS_TEST_HOOKS: '1',
      }),
    ).toThrow(/not one of/);
  });

  it('is never honoured in a run labelled live', () => {
    expect(() =>
      parseMutation({
        ...LIVE,
        NEMODOTS_MUTATION: 'skip_freshness',
        NEMODOTS_TEST_HOOKS: '1',
      }),
    ).toThrow(/labelled live/);
  });

  it('lists exactly the six catalogue names', () => {
    expect([...MUTATIONS].sort()).toEqual(
      [
        'accept_duplicate_differing_payloads',
        'bypass_final_version_check',
        'drop_inherited_edges',
        'ignore_fencing',
        'skip_effect_marker',
        'skip_freshness',
      ].sort(),
    );
  });
});
