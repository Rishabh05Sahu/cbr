import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/**
 * Raw database clients are importable only inside the db gateway (src/platform/**, and
 * each spike's own db/ folder). Modules and routes must use withTenant() from
 * '@/platform/db' (database-design.md §2.5, spike criterion S1-09).
 */
const RAW_DB = {
  group: [
    '@prisma/client',
    '@prisma/client/*',
    '@prisma/adapter-pg',
    'pg',
    '**/generated/prisma',
    '**/generated/prisma/*',
    '@/generated/**',
    '@/platform/db/client',
    // crm_cleanup lookup (cross-org storage keys): worker cleanup sweep only.
    '@/platform/db/cleanup',
  ],
  message:
    'Raw database clients are only allowed in src/platform. Use tenantRunner().withTenant() from @/platform/db.',
};

/** ADR-0003: modules never call the auth library; they receive a RequestContext. */
const AUTH_LIBRARY = {
  group: ['better-auth', 'better-auth/*'],
  message: 'The auth library is only used in src/platform/auth. Use the RequestContext.',
};

/** Raw drivers and generated clients stay banned; the gateway module itself is allowed. */
const RAW_DB_EXCEPT_GATEWAY = {
  group: RAW_DB.group.filter((g) => g !== '@/platform/db/client'),
  message: RAW_DB.message,
};

/** The storage SDK holds the service-role key: only the server-side storage gateway may use it. */
const STORAGE_SDK = {
  group: ['@supabase/*'],
  message: 'Use importStorage() from @/platform/storage (server only). Browsers get signed URLs.',
};

/** Spreadsheet readers run only in the worker, behind the import file checks (M4). */
const PARSERS = {
  group: ['read-excel-file', 'read-excel-file/*', 'csv-parse', 'csv-parse/*'],
  message: 'Use parseImportFile() from @/modules/imports (worker only, after inspectFileBytes).',
};

/** Import processing parses spreadsheets: worker only (and its tests), never web code. */
const WORKER_ONLY = {
  group: [
    '@/modules/imports/processor',
    '@/modules/imports/cleanup',
    '@/modules/imports/parse',
    '@/modules/exports/processor',
    '@/modules/exports/cleanup',
  ],
  message:
    'Worker-only import/export code. Web code uses @/modules/imports or @/modules/exports instead.',
};

const restrict = (...patterns) => ['error', { patterns }];

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      '**/generated/**',
      'next-env.d.ts',
      'docs/**',
      'coverage/**',
      'dist/**',
    ],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': restrict(RAW_DB, AUTH_LIBRARY, STORAGE_SDK, PARSERS, WORKER_ONLY),
    },
  },
  {
    // Tests may drive the worker-side import steps directly.
    files: ['tests/integration/**', 'tests/e2e/**'],
    rules: { 'no-restricted-imports': restrict(RAW_DB, AUTH_LIBRARY, STORAGE_SDK, PARSERS) },
  },
  {
    // These tests drive the worker's crm_cleanup gateway directly.
    files: [
      'tests/integration/import-cleanup-role.test.ts',
      'tests/integration/import-flow.test.ts',
      'tests/integration/lead-export.test.ts',
      'tests/e2e/m5-routes.test.ts',
    ],
    rules: {
      'no-restricted-imports': restrict(
        { ...RAW_DB, group: RAW_DB.group.filter((g) => g !== '@/platform/db/cleanup') },
        AUTH_LIBRARY,
        STORAGE_SDK,
        PARSERS,
      ),
    },
  },
  {
    // The one place the spreadsheet readers are used.
    files: ['src/modules/imports/parse.ts'],
    rules: { 'no-restricted-imports': restrict(RAW_DB, AUTH_LIBRARY, STORAGE_SDK) },
  },
  {
    // The gateway, platform plumbing, and the worker entrypoint (shutdown).
    files: ['src/platform/**', 'spikes/*/db/**', 'src/worker/main.ts'],
    ignores: ['src/platform/auth/**'],
    rules: { 'no-restricted-imports': restrict(AUTH_LIBRARY, STORAGE_SDK, PARSERS) },
  },
  {
    // The storage gateway is the only code that may hold the storage SDK (service-role key).
    files: ['src/platform/storage/**'],
    rules: { 'no-restricted-imports': restrict(RAW_DB, AUTH_LIBRARY, PARSERS) },
  },
  {
    // The auth platform may use the auth library and the gateway's client module
    // (crm_auth), but never construct raw drivers or import generated clients itself.
    files: ['src/platform/auth/**', 'spikes/*/auth/**'],
    rules: { 'no-restricted-imports': restrict(RAW_DB_EXCEPT_GATEWAY, STORAGE_SDK, PARSERS) },
  },
  {
    // Platform console runs as crm_platform (no tenant PII grants; see prisma/README.md).
    files: ['src/modules/platform-admin/**'],
    rules: {
      'no-restricted-imports': restrict(AUTH_LIBRARY, RAW_DB_EXCEPT_GATEWAY, STORAGE_SDK, PARSERS),
    },
  },
  {
    // Test support and setup may connect as any role to assert on the database. So may the
    // managed-database test runner (operator tooling; not in any image).
    files: [
      'tests/support/**',
      'tests/setup/**',
      'tests/e2e/server.ts',
      '**/prisma.config.ts',
      'scripts/managed-db/**',
      // Role provisioning (operator tooling): verifies a login after provisioning.
      'scripts/db/**',
      // M6 load-test harness (operator tooling, local crm_perf only): verifies role identities
      // and asserts on the database; never imported by the app.
      'scripts/perf/**',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
];

export default config;
