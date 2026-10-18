// Pure pieces of the dispatch path: marker parsing, script reply parsing and
// the shape of the Lua script (marker first, strictly-newer fence, UNLINK).
import { describe, expect, it } from 'vitest';
import {
  EFFECT_SCRIPT,
  effectKey,
  fenceKey,
  parseMarker,
  parseScriptReply,
  withinBudget,
} from '../../../src/server/nemodots/actions/dispatch.js';
import { EffectUnavailableError } from '../../../src/server/nemodots/actions/errors.js';

describe('effect markers', () => {
  it('parses what the script writes', () => {
    expect(parseMarker('applied:12:7')).toEqual({
      kind: 'applied',
      fence: 12,
      deleted: 7,
    });
    expect(parseMarker('fence_newer:9')).toEqual({
      kind: 'fence_newer',
      fence: 9,
    });
    expect(parseMarker('tombstone:reconcile')).toEqual({ kind: 'tombstone' });
    expect(parseMarker('pending:3')).toEqual({ kind: 'pending' });
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker('applied:x:y')).toEqual({
      kind: 'unreadable',
      raw: 'applied:x:y',
    });
  });

  it('keys live under the configured prefix', () => {
    expect(effectKey('nemodots:t', 'abc')).toBe('nemodots:t:effect:abc');
    expect(fenceKey('nemodots:t')).toBe('nemodots:t:fence:cache.namespace');
  });
});

describe('script reply', () => {
  it('parses the five-element reply', () => {
    expect(parseScriptReply(['applied', 4, 0, 6, 'applied:3:4'])).toEqual({
      result: 'applied',
      deleted: 4,
      fenceBefore: 0,
      fenceAfter: 6,
      marker: 'applied:3:4',
    });
  });
  it('refuses anything else', () => {
    expect(() => parseScriptReply(null)).toThrow(EffectUnavailableError);
    expect(() => parseScriptReply(['maybe', 0, 0, 0, ''])).toThrow(
      EffectUnavailableError,
    );
  });
});

describe('the Lua script', () => {
  it('writes the marker with NX before anything else and orders the fence strictly', () => {
    const marker = EFFECT_SCRIPT.indexOf("'NX'");
    const fence = EFFECT_SCRIPT.indexOf('fenceBefore > committed');
    const unlink = EFFECT_SCRIPT.indexOf("'UNLINK'");
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(fence);
    expect(fence).toBeLessThan(unlink);
    expect(EFFECT_SCRIPT).toContain("'already_applied'");
    expect(EFFECT_SCRIPT).toContain("'fence_newer'");
    expect(EFFECT_SCRIPT).not.toContain('FLUSH');
  });
});

describe('withinBudget', () => {
  it('rejects with EffectUnavailableError when the call does not answer in time', async () => {
    await expect(
      withinBudget(new Promise(() => {}), 20, 'a call'),
    ).rejects.toBeInstanceOf(EffectUnavailableError);
    await expect(withinBudget(Promise.resolve(1), 20, 'a call')).resolves.toBe(
      1,
    );
  });
});
