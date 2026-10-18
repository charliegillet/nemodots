import { defineConfig } from 'vitest/config';

// Browser end-to-end suites (Playwright library, system Chrome) against a
// built server and a ci-* stack. Files share the stack and the screenshot
// directory, so they run serially. global-setup checks the prerequisites and
// scans the run's artifacts for secrets afterwards.
export default defineConfig({
  test: {
    include: ['tests/nemodots/e2e/**/*.test.ts'],
    globalSetup: ['tests/nemodots/e2e/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
