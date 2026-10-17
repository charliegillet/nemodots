import { defineConfig } from 'vitest/config';

// Live Crusoe/Nemotron suites. They make billed provider calls, so files run
// one at a time and the in-flight cap stays within the provider limit.
export default defineConfig({
  test: {
    include: ['tests/nemodots/live/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
