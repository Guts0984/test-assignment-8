import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Real PostgreSQL; every file creates its own database, so files may run in parallel.
    fileParallelism: true,
  },
});
