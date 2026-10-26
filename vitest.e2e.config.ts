import { defineConfig } from 'vitest/config';

// Against a real eventkit-core: EVENTKIT_API_URL and EVENTKIT_PLATFORM_KEY.
export default defineConfig({
  test: { include: ['test/e2e/**/*.test.ts'], testTimeout: 30_000, fileParallelism: false },
});
