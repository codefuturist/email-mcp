import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/__integration__/**'],
    reporters: ['default', 'junit', 'json'],
    outputFile: {
      junit: 'reports/test-results.xml',
      json: 'reports/test-results.json',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'reports/coverage',
    },
    testTimeout: 10_000,
  },
});
