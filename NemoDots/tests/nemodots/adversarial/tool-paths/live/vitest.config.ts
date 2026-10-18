import { defineConfig } from 'vitest/config';

// W5.3 live adversary turns (billed: Crusoe inference + CopilotKit
// Intelligence threads). Never part of `npm test` or `test:nemodots:db`
// (neither config includes *.live.ts). Run explicitly:
//   npx vitest run --config tests/nemodots/adversarial/tool-paths/live/vitest.config.ts
export default defineConfig({
  test: {
    include: ['tests/nemodots/adversarial/tool-paths/live/**/*.live.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
