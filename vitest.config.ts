import { defineConfig } from 'vitest/config';

/**
 * Test layers (see docs/llms.txt § Testing):
 *   unit         pure logic, no I/O. Co-located: packages/service/src/**\/*.test.ts
 *   integration  LIVE Postgres (compose `db-test`). Every test gets a brand-new, empty, fully
 *                migrated database cloned from a sealed template, and a real HTTP server.
 *                No DB mocks.  packages/service/test/{integration,scenarios}/**
 *   e2e          the real `docker compose` stack over HTTP (E2E_BASE_URL). Same scenario files
 *                as integration (test/scenarios), plus test/e2e/**.  Run via `pnpm test:e2e`.
 */
const svc = 'packages/service';

export default defineConfig({
  test: {
    reporters: process.env.CI ? ['dot'] : ['default'],
    projects: [
      {
        test: {
          name: 'unit',
          include: [`${svc}/src/**/*.test.ts`, 'scripts/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: [`${svc}/test/integration/**/*.test.ts`, `${svc}/test/scenarios/**/*.test.ts`],
          environment: 'node',
          globalSetup: [`${svc}/test/harness/global-setup.ts`],
          setupFiles: [`${svc}/test/harness/setup-matchers.ts`],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // Parallel files are safe: each test owns its own database.
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'e2e',
          include: [`${svc}/test/e2e/**/*.test.ts`, `${svc}/test/scenarios/**/*.test.ts`],
          environment: 'node',
          globalSetup: [`${svc}/test/harness/e2e-global-setup.ts`],
          setupFiles: [`${svc}/test/harness/setup-matchers.ts`],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env: { TEST_TARGET: 'e2e' },
        },
      },
    ],
  },
});
