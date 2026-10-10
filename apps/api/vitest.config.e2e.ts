import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Test files share one database, so run them one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgresql://firstframe:firstframe@localhost:5432/firstframe_test',
      REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_DIR: './tmp/test-storage',
      UPLOAD_TMP_DIR: './tmp/test-uploads',
      PAYMENTS_PROVIDER: 'mock',
      PLATFORM_FEE_PERCENT: '30',
    },
  },
});
