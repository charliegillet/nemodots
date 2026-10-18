import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// W5.2 concurrency adversary. vitest.integration.config.ts only includes
// tests/nemodots/integration/**, so `npm run test:nemodots:db -- <this dir>`
// selects nothing; run this config through the stack env instead:
//   node scripts/nemodots/stack.mjs exec -- npx vitest run \
//     --config tests/nemodots/adversarial/concurrency/vitest.config.ts
export default defineConfig({
  root: fileURLToPath(new URL('../../../../', import.meta.url)),
  test: {
    include: ['tests/nemodots/adversarial/concurrency/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    env: { NEMODOTS_TEST_HOOKS: '1', DO_NOT_TRACK: '1' },
  },
});
