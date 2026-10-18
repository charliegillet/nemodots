import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Independent verifier's acceptance suite (docs/nemodots/ACCEPTANCE_CONTRACT.md).
// Run with `npm run test:nemodots:acceptance`, which loads the instance's
// roles.env through scripts/nemodots/stack.mjs exec. Suites share the
// NemoDots PostgreSQL/Redis/checkout ports, so files run one at a time.
const appRoot = fileURLToPath(new URL('../../../', import.meta.url));

export default defineConfig({
  root: appRoot,
  test: {
    include: ['tests/nemodots/acceptance/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.local/**'],
    testTimeout: 600_000,
    hookTimeout: 300_000,
    teardownTimeout: 120_000,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false, shuffle: false },
    retry: 0,
    reporters: ['default'],
  },
});
