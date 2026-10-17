import { defineConfig } from 'vitest/config';

// Browser end-to-end suites (Playwright library, system Chrome) against a
// built server and a ci-* stack. Files share ports, so they run serially.
export default defineConfig({
  test: {
    include: ['tests/nemodots/e2e/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
