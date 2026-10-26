import { defineConfig } from 'vitest/config';

const strict = { lines: 100, branches: 100, functions: 100, statements: 100 };

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['test/e2e/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/schema.d.ts', 'src/index.ts', 'src/types.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
        'src/http.ts': strict,
        'src/session.ts': strict,
        'src/uploads.ts': strict,
        'src/scanner.ts': strict,
        'src/errors.ts': strict,
      },
    },
  },
});
