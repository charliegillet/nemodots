import { defineConfig } from 'vitest/config';

// PostgreSQL/Redis suites against the NemoDots stack (55432/56379). Run with
// `npm run test:nemodots:db`, which loads the instance's roles.env.
export default defineConfig({
  test: {
    include: [
      'tests/nemodots/integration/**/*.test.ts',
      // W5.2/W5.3 adversarial suites run against the same stack.
      'tests/nemodots/adversarial/**/*.test.ts',
    ],
    setupFiles: ['tests/nemodots/helpers/pg-error-guard.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
