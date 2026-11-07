// Isolated local database for the M6 load test: `crm_perf` in the local Docker Compose Postgres.
// Same method as the approved recovery drill (scripts/recovery/logical-restore-drill.mjs):
// create a throwaway database owned by crm_migrator, grant the runtime roles CONNECT, enable the
// extensions, provision crm_cleanup's CONNECT (role already exists cluster-wide), and apply the
// repository's migrations with `prisma migrate deploy`. It never touches crm_dev or crm_test.
//
//   node scripts/perf/perf-db.mjs create   # refuses if crm_perf already exists
//   node scripts/perf/perf-db.mjs status   # identity, migrations, row counts
//   node scripts/perf/perf-db.mjs drop     # cleanup: DROP DATABASE crm_perf (only that name)
//
// Synthetic data only. Prints no credentials.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import 'dotenv/config';
import pg from 'pg';
import { psql } from '../recovery/lib.mjs';

const C = process.env.DRILL_CONTAINER ?? 'cbr-crm-postgres-1';
const DB = 'crm_perf';
const ROLES = ['crm_app', 'crm_auth', 'crm_platform', 'crm_migrator', 'crm_cleanup'];

/** A role URL for crm_perf, built from the crm_test URL of the same role (password reused). */
export function perfUrl(testVar) {
  const u = new URL(process.env[testVar]);
  if (u.hostname !== '127.0.0.1' || u.port !== '55432' || u.pathname !== '/crm_test')
    throw new Error(`${testVar} is not the local crm_test URL`);
  u.pathname = `/${DB}`;
  return u.toString();
}

const exists = () =>
  psql(C, 'postgres', `SELECT count(*) FROM pg_database WHERE datname = '${DB}'`) === '1';

async function identity() {
  const vars = {
    crm_app: 'TEST_DATABASE_URL',
    crm_auth: 'TEST_AUTH_DATABASE_URL',
    crm_platform: 'TEST_PLATFORM_DATABASE_URL',
    crm_migrator: 'TEST_MIGRATOR_URL',
    crm_cleanup: 'TEST_CLEANUP_DATABASE_URL',
  };
  for (const role of ROLES) {
    const c = new pg.Client({ connectionString: perfUrl(vars[role]) });
    await c.connect();
    const r = await c.query('SELECT current_user u, current_database() d, inet_server_port() p');
    await c.end();
    if (r.rows[0].u !== role || r.rows[0].d !== DB)
      throw new Error(`identity mismatch for ${role}`);
  }
  return 'crm_perf identity OK (5 roles, 127.0.0.1:55432)';
}

async function create() {
  if (exists()) throw new Error(`${DB} already exists; run "drop" first (nothing changed)`);
  psql(C, 'postgres', `CREATE DATABASE ${DB} OWNER crm_migrator`);
  psql(
    C,
    DB,
    `REVOKE ALL ON DATABASE ${DB} FROM PUBLIC;
     GRANT CONNECT ON DATABASE ${DB} TO crm_app, crm_platform, crm_auth;
     CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS btree_gist;
     CREATE EXTENSION IF NOT EXISTS pg_trgm;
     ALTER SCHEMA public OWNER TO crm_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
     GRANT USAGE ON SCHEMA public TO crm_app, crm_platform, crm_auth, crm_definer;`,
  );
  // crm_cleanup exists cluster-wide; the shared SQL (no verifier → password unchanged) re-asserts
  // its attributes and grants CONNECT on this database only.
  const sql = readFileSync('scripts/db/provision-cleanup-role.sql', 'utf8');
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      C,
      'psql',
      '-U',
      'postgres',
      '-d',
      DB,
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `db=${DB}`,
      '-qtA',
      '-f',
      '-',
    ],
    { input: sql, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`cleanup role grant failed: ${r.stderr}`);
  const m = spawnSync('pnpm exec prisma migrate deploy', {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_MIGRATOR_URL: perfUrl('TEST_MIGRATOR_URL') },
  });
  if (m.status !== 0) throw new Error(`migrate failed: ${(m.stderr || m.stdout).slice(-2000)}`);
  console.log(await identity());
  console.log(
    'migrations:',
    psql(
      C,
      DB,
      `SELECT string_agg(migration_name, ',' ORDER BY migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    ),
  );
}

async function status() {
  if (!exists()) return console.log(`${DB} does not exist`);
  console.log(await identity());
  console.log(
    'migrations:',
    psql(
      C,
      DB,
      `SELECT string_agg(migration_name, ',' ORDER BY migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
    ),
  );
  console.log(
    'rows:',
    psql(
      C,
      DB,
      `SELECT (SELECT count(*) FROM organization) || ' orgs, ' || (SELECT count(*) FROM lead) || ' leads, ' || (SELECT count(*) FROM lead_activity) || ' activities'`,
    ),
  );
  console.log('size:', psql(C, DB, `SELECT pg_size_pretty(pg_database_size('${DB}'))`));
  console.log(
    'proposed objects:',
    psql(
      C,
      DB,
      `SELECT coalesce(string_agg(x, ','), 'none') FROM (
         SELECT 'column lead.email_normalized' x FROM information_schema.columns
          WHERE table_name = 'lead' AND column_name = 'email_normalized'
         UNION ALL SELECT 'index ' || indexname FROM pg_indexes
          WHERE tablename = 'lead' AND indexname IN
            ('lead_org_id_email_normalized_idx', 'lead_org_id_full_name_id_idx')) s`,
    ),
  );
}

function drop() {
  if (!exists()) return console.log(`${DB} does not exist; nothing to drop`);
  psql(C, 'postgres', `DROP DATABASE ${DB} WITH (FORCE)`);
  console.log(`dropped ${DB}`);
}

/**
 * Applies one PROPOSED migration (prisma/proposed/<name>/migration.sql, not yet promoted to
 * prisma/migrations) to crm_perf only, as crm_migrator, in one transaction. Prints the elapsed
 * time (the M6 report measures the migration's own cost).
 */
async function apply(name) {
  if (!/^\d{4}_[a-z0-9_]+$/.test(name ?? '')) throw new Error('usage: apply <0007_name>');
  const sql = readFileSync(`prisma/proposed/${name}/migration.sql`, 'utf8');
  if (!exists()) throw new Error(`${DB} does not exist`);
  const c = new pg.Client({ connectionString: perfUrl('TEST_MIGRATOR_URL') });
  await c.connect();
  try {
    const r = await c.query('SELECT current_user u, current_database() d, inet_server_port() p');
    if (r.rows[0].u !== 'crm_migrator' || r.rows[0].d !== DB)
      throw new Error('refusing: not crm_perf as crm_migrator');
    const t = performance.now();
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('COMMIT');
    console.log(`applied ${name} to ${DB} in ${Math.round(performance.now() - t)} ms`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}

const cmd = process.argv[2];
if (cmd === 'create') await create();
else if (cmd === 'status') await status();
else if (cmd === 'drop') drop();
else if (cmd === 'apply') await apply(process.argv[3]);
else {
  console.log('usage: node scripts/perf/perf-db.mjs create|status|drop|apply <proposed migration>');
  process.exit(2);
}
