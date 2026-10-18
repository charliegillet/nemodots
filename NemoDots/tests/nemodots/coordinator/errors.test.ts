import { describe, expect, it } from 'vitest';
import {
  FenceError,
  SupportError,
  isSupportError,
} from '../../../src/server/nemodots/coordinator/errors.js';

describe('isSupportError', () => {
  it('recognises the coordinator class and a foreign class of the same shape (the ledger may not import the coordinator)', () => {
    expect(isSupportError(new SupportError('stale_version'))).toBe(true);
    class LedgerSupportError extends Error {
      override name = 'SupportError';
      constructor(readonly reason: string) {
        super(`ledger: ${reason}`);
      }
    }
    expect(isSupportError(new LedgerSupportError('evidence_too_old'))).toBe(
      true,
    );
  });
  it('does not mistake other failures for support rejections', () => {
    expect(isSupportError(new FenceError('a', 'token_mismatch'))).toBe(false);
    expect(isSupportError(new Error('SupportError'))).toBe(false);
    const nameOnly = Object.assign(new Error('x'), { name: 'SupportError' });
    expect(isSupportError(nameOnly)).toBe(false); // no machine reason
    expect(isSupportError({ name: 'SupportError', reason: 'x' })).toBe(false);
    expect(isSupportError(null)).toBe(false);
  });
});

describe('FenceError', () => {
  it('carries the attempt id and the reason', () => {
    const error = new FenceError('attempt-1', 'lease_expired', 'late');
    expect(error.name).toBe('FenceError');
    expect(error.reason).toBe('lease_expired');
    expect(error.message).toContain('attempt-1');
  });
});
