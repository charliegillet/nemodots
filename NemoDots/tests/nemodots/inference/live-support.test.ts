import { describe, expect, it } from 'vitest';
import {
  beginTest,
  endTest,
  record,
  suiteFailed,
} from '../live/inference/support.js';

// Regression: the live results file once said PASS for a run whose assertions
// failed, because a check was recorded PASS as soon as the call returned.
describe('live results bookkeeping', () => {
  it('a passing test keeps its checks PASS and the suite passes', () => {
    beginTest();
    record({ name: 'a', status: 'PASS' });
    endTest('a', 'pass');
    expect(suiteFailed()).toBe(false);
  });

  it('a failed test flips its recorded checks to FAIL and fails the suite', () => {
    const check = { name: 'b', status: 'PASS' as const };
    beginTest();
    record(check);
    endTest('b', 'fail');
    expect(check.status).toBe('FAIL');
    expect(suiteFailed()).toBe(true);
  });
});
