// Runs the integration project against the throwaway local crm_perf instead of crm_test (M6: the
// suites needed 0007/0008 before they were promoted to crm_test on 2026-10-26; kept for runs on
// a throwaway database). Rewrites the five TEST_* URLs from crm_test to crm_perf (local
// 127.0.0.1:55432 only), verifies crm_perf has the 0007/0008 objects, then starts vitest.
// crm_perf is emptied by the normal globalSetup.
//
//   node scripts/perf/test-on-perf.mjs [vitest file filters…]
import { spawnSync } from 'node:child_process';
import 'dotenv/config';
import pg from 'pg';

const VARS = [
  'TEST_DATABASE_URL',
  'TEST_AUTH_DATABASE_URL',
  'TEST_PLATFORM_DATABASE_URL',
  'TEST_CLEANUP_DATABASE_URL',
  'TEST_MIGRATOR_URL',
];
const env = { ...process.env };
for (const v of VARS) {
  const u = new URL(process.env[v]);
  if (u.hostname !== '127.0.0.1' || u.port !== '55432' || u.pathname !== '/crm_test')
    throw new Error(`${v} is not the local crm_test URL`);
  u.pathname = '/crm_perf';
  env[v] = u.toString();
}
const c = new pg.Client({ connectionString: env.TEST_MIGRATOR_URL });
await c.connect();
const r = (
  await c.query(`SELECT current_database() d, current_user u,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lead' AND column_name = 'email_normalized') col,
    EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'lead_org_id_email_normalized_idx') e,
    EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'lead_org_id_full_name_id_idx') n`)
).rows[0];
await c.end();
if (r.d !== 'crm_perf' || r.u !== 'crm_migrator') throw new Error('refusing: not crm_perf');
if (!r.col || !r.e || !r.n) throw new Error('crm_perf lacks the proposed 0007/0008 objects');
// Never reach the real storage bucket from this run.
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) env[k] = '';
console.log('running integration tests on crm_perf (0001–0008)');
const t = spawnSync(
  'corepack',
  ['pnpm', 'exec', 'vitest', 'run', '--project', 'integration', ...process.argv.slice(2)],
  { stdio: 'inherit', env, shell: true },
);
process.exit(t.status ?? 1);
