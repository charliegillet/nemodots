import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// `npm test` stays Node-only, network-free and stack-free: suites that need
// PostgreSQL/Redis, Crusoe, a browser or the verifier's acceptance contract
// run through their own configs (vitest.integration/live/e2e.config.ts).
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      exclude: [
        ...configDefaults.exclude,
        '.local/**',
        'tests/nemodots/integration/**',
        'tests/nemodots/live/**',
        'tests/nemodots/e2e/**',
        'tests/nemodots/acceptance/**',
      ],
    },
  }),
);
