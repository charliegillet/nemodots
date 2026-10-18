import { defineConfig } from 'vitest/config';

// PostgreSQL/Redis suites against the NemoDots stack (55432/56379). Run with
// `npm run test:nemodots:db`, which loads the instance's roles.env.
export default defineConfig({
  test: {
    include: ['tests/nemodots/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
