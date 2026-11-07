// Vitest globalSetup: empty crm_test (schema kept) and Valkey db 1 before a run.
// Refuses to run against anything but a database named crm_test, or the throwaway local load-test
// database crm_perf (M6: suites that need proposed migrations not yet applied to crm_test).
import 'dotenv/config';
import { Redis } from 'ioredis';
import pg from 'pg';

const TEST_DATABASES = ['/crm_test', '/crm_perf'];

export default async function setup() {
  const url = process.env.TEST_MIGRATOR_URL;
  if (!url || !TEST_DATABASES.includes(new URL(url).pathname))
    throw new Error('TEST_MIGRATOR_URL must point at crm_test (or the local crm_perf)');
  if (new URL(url).pathname === '/crm_perf' && new URL(url).hostname !== '127.0.0.1')
    throw new Error('crm_perf is only the local load-test database');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ t: string }>(
      `SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
    );
    if (rows.length) await client.query(`TRUNCATE ${rows.map((r) => r.t).join(', ')} CASCADE`);
  } finally {
    await client.end();
  }
  const redis = new Redis(
    `${(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379').replace(/\/\d+$/, '')}/1`,
  );
  await redis.flushdb();
  await redis.quit();
}
