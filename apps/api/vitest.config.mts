import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Attack tests measure latency of innocent users while a flood runs: run files one at a time.
    fileParallelism: false,
  },
});
