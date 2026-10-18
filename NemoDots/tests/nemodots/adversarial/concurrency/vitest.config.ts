import { defineConfig } from 'vitest/config';

// Direct runner for the concurrency adversary's suites (they also run under
// vitest.integration.config.ts once its include covers tests/nemodots/adversarial).
// Run through the stack script so the instance's role URLs are loaded:
//   npm run test:nemodots:db -- --config tests/nemodots/adversarial/concurrency/vitest.config.ts
export default defineConfig({
  test: {
    root: process.cwd(),
    include: ['tests/nemodots/adversarial/concurrency/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
