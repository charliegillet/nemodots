import { defineConfig } from 'vitest/config';

// Direct runner for the integration devil's advocate (W5.3). Run through the
// stack script so the instance's role URLs and the Crusoe/Intelligence names
// are available to the suites that need them:
//   npm run test:nemodots:db -- --config tests/nemodots/adversarial/tool-paths/vitest.config.ts
// The network-free part (no PostgreSQL, no keys) runs under the ordinary
// config as well:
//   npx vitest run tests/nemodots/adversarial/tool-paths/registry.test.ts
// Files run one at a time: the live file makes billed provider calls and the
// DB files create databases on the shared instance.
export default defineConfig({
  test: {
    root: process.cwd(),
    include: ['tests/nemodots/adversarial/tool-paths/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
