import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          // Plus the database-free checks of the managed-run tooling and the S1 override guard.
          include: [
            'src/**/*.test.ts',
            'scripts/managed-db/**/*.test.mjs',
            'spikes/s1-tenant-isolation/db/**/*.test.ts',
            'tests/support/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/setup/reset-test-db.ts'],
          setupFiles: ['tests/setup/test-env.ts', 'tests/setup/teardown.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/setup/reset-test-db.ts', 'tests/e2e/server.ts'],
          setupFiles: ['tests/setup/test-env.ts', 'tests/setup/teardown.ts'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 300_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 's1',
          include: ['spikes/s1-tenant-isolation/tests/**/*.test.ts'],
          environment: 'node',
          // dotenv/config, minus the S1-08 diagnostic keys (never from .env).
          setupFiles: ['spikes/s1-tenant-isolation/setup-env.ts'],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 600_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 's2',
          include: ['spikes/s2-identity/tests/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['dotenv/config'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
