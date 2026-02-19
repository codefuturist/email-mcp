import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__integration__/**/*.integration.test.ts'],
    reporters: ['default', 'junit', 'json'],
    outputFile: {
      junit: 'reports/integration-results.xml',
      json: 'reports/integration-results.json',
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1,
    globalSetup: ['src/__integration__/globalSetup.ts'],
    sequence: {
      concurrent: false,
    },
  },
});
