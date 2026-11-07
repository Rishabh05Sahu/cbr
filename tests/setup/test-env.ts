// Points the app's runtime env at the test database (crm_test) and Valkey db 1.
// Loaded before any module under test reads serverEnv().
import 'dotenv/config';

const required = [
  'TEST_DATABASE_URL',
  'TEST_AUTH_DATABASE_URL',
  'TEST_PLATFORM_DATABASE_URL',
  'TEST_CLEANUP_DATABASE_URL',
  'TEST_MIGRATOR_URL',
];
for (const k of required)
  if (!process.env[k]) throw new Error(`${k} is not set (see .env.example)`);

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.AUTH_DATABASE_URL = process.env.TEST_AUTH_DATABASE_URL;
process.env.PLATFORM_DATABASE_URL = process.env.TEST_PLATFORM_DATABASE_URL;
process.env.CLEANUP_DATABASE_URL = process.env.TEST_CLEANUP_DATABASE_URL;
process.env.DATABASE_MIGRATOR_URL = process.env.TEST_MIGRATOR_URL;
process.env.REDIS_URL = `${(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379').replace(/\/\d+$/, '')}/1`;
process.env.BETTER_AUTH_URL = process.env.TEST_APP_URL ?? 'http://127.0.0.1:3100';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
