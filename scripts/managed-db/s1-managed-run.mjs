// S1-18: run the S1 tenant-isolation suite and the production-schema role checks against a
// MANAGED PostgreSQL cluster (owner approval 2026-10-20, item A; Neon run 2026-10-21).
// Synthetic data only.
//
// Inputs (environment only; nothing is written to disk except scrubbed logs and results):
//   MANAGED_ADMIN_URL      provider admin URL to the default database, TLS required
//   MANAGED_CA_FILE        path to the provider's CA certificate (TLS verification)
//   MANAGED_POOL_NAME      optional: name of a provider pool (PgBouncer, transaction mode,
//                          database crm_s1, "inbound user") for the pooled S1-03…S1-08 re-run;
//                          the pool must exist before the run (create crm_s1 in the panel first)
//   MANAGED_POOL_PORT      optional: pool port (DigitalOcean: 25061)
//   MANAGED_POOL_HOST      optional, instead of the pool name: a pooler host that serves every
//                          database on the same port (Neon: the "-pooler" endpoint host)
//   MANAGED_LABEL          optional: run directory prefix (default "managed")
//   MANAGED_TARGET         optional: JSON of verified, non-secret target identifiers to record
//   MANAGED_TEST_TIMEOUT_MS optional: vitest --testTimeout for remote round trips (wall clock only)
//   MANAGED_MUTATION_CHECK=1 optional: add a permissive policy, prove S1-03…07 fail, remove it,
//                          prove the policies are back as before and S1-03…07 pass again
//   MANAGED_SERVER_TIMING=1 optional: S1-17 list queries timed inside the server (no network),
//                          supplementary to S1-17, which measures from the test machine
//   MANAGED_BATCHES        optional: comma list of batch names to run (others: "not selected")
//   MANAGED_RESUME_DIR     optional: continue an interrupted run in that directory (see below)
//   MANAGED_DIAG_TX_MAX_WAIT_MS optional, Neon WAN diagnostic only (set by neon-s1.mjs
//                          --diagnostic-tx-max-wait-ms): S1-08's transaction-start budget instead of
//                          the binding 30 000 ms. Validated by diagnostic-override.mjs (verified Neon
//                          test branch, never production; batches s1-08, pooled-s1-08, db-roles only);
//                          labelled diagnostic and non-binding in the run directory, state and report.
//                          Accepted only with MANAGED_DIAG_AUTH_FILE/_NONCE, the one-time
//                          authorization neon-s1.mjs issues (a direct invocation cannot enable it).
//                          Those batches also get S1_CONNECTION_TIMEOUT_MS = maxWait + 10 000 ms,
//                          over any ambient value; both are recorded per batch in state.json.
//
// Neon: scripts/managed-db/neon-s1.mjs verifies the branch and sets these inputs.
//
// Checkpoints. Every run has a directory (Git-ignored) under spikes/results/managed-runs/:
//   state.json   setup steps and batches with their status, rewritten atomically after each change
//   tests.jsonl  one line per collected test and per finished test, fsynced as it happens
//                (scripts/managed-db/checkpoint-reporter.mjs)
//   run.log      scrubbed output, appended live
//   plan-*.json  static test listing, used only for batches that never started
//   report.{json,md}  built by scripts/managed-db/s1-report.mjs (also runnable on its own after
//                an interruption; an unfinished test is never counted as passed)
//
// Batches are independent test files: each seeds its own synthetic orgs and tolerates data
// from earlier runs (the local suite is run repeatedly on one database). Resume skips batches
// that finished and re-runs an interrupted batch as a whole, never single tests. Setup is not
// resumable: if setup was interrupted, clean the database and start again. On resume the
// generated roles get new random passwords (the old ones lived only in the stopped process).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTH_FILE_ENV,
  AUTH_NONCE_ENV,
  assertNoDirectDiagnosticEnv,
  authorizeDiagnosticRun,
  diagnosticSettingsOf,
  withDiagnosticEnv,
} from './diagnostic-override.mjs';
import { buildReport, runExitStatus } from './s1-report.mjs';

const PSQL_IMAGE = 'postgres:18.6-trixie';
// The S1_DIAG_* variables reach the S1-08 test only from here, never from the shell.
assertNoDirectDiagnosticEnv(process.env);
// The override needs neon-s1.mjs's one-time authorization; hand-set MANAGED_TARGET and
// MANAGED_DIAG_TX_MAX_WAIT_MS alone are refused. Checked before anything is created or connected.
const DIAG = authorizeDiagnosticRun(process.env);
// The nonce is spent: child processes never see it.
delete process.env[AUTH_FILE_ENV];
delete process.env[AUTH_NONCE_ENV];
const TARGET = process.env.MANAGED_TARGET ? JSON.parse(process.env.MANAGED_TARGET) : null;
const BASE_LABEL = process.env.MANAGED_LABEL ?? 'managed';
const LABEL = DIAG && !BASE_LABEL.endsWith('-diagnostic') ? `${BASE_LABEL}-diagnostic` : BASE_LABEL;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const BASE =
  process.env.MANAGED_REHEARSAL === '1'
    ? 'spikes/results/managed-rehearsal'
    : 'spikes/results/managed-runs';
const RESUME = process.env.MANAGED_RESUME_DIR;
const DIR = RESUME ?? `${BASE}/${LABEL}-${stamp}`;
const STATE = `${DIR}/state.json`;
const TESTS = resolve(`${DIR}/tests.jsonl`);
const LOG = `${DIR}/run.log`;
const REPORTER = resolve('scripts/managed-db/checkpoint-reporter.mjs');

const admin = process.env.MANAGED_ADMIN_URL;
// verify-full against the provider CA. `disable` exists only for the local rehearsal.
const sslmode = process.env.MANAGED_SSLMODE ?? 'verify-full';
if (!admin) throw new Error('MANAGED_ADMIN_URL is required');
const ca = process.env.MANAGED_CA_FILE ? resolve(process.env.MANAGED_CA_FILE) : null;
if (sslmode !== 'disable' && !ca) throw new Error('MANAGED_CA_FILE is required for TLS');
if (ca) readFileSync(ca); // must exist
if (RESUME && !existsSync(STATE)) throw new Error(`no state.json in ${RESUME}`);

// Fresh random passwords for every invocation, held only in memory.
const pw = Object.fromEntries(
  ['migrator', 'app', 'auth', 'platform'].map((r) => [r, randomBytes(24).toString('base64url')]),
);
const adminUrl = new URL(admin);
const adminDb = adminUrl.pathname.slice(1) || 'defaultdb';
const secrets = [decodeURIComponent(adminUrl.password), ...Object.values(pw)].filter(Boolean);
const scrub = (s) =>
  secrets
    .reduce((acc, x) => acc.split(x).join('***'), String(s ?? ''))
    .replace(/postgres(ql)?:\/\/[^\s'"]+/g, '<url>');

mkdirSync(DIR, { recursive: true });
const note = (s) => {
  const line = scrub(s);
  appendFileSync(LOG, `${line}\n`);
  console.log(line);
};

/** URL for node-postgres (verify-full against the provider CA). */
function nodeUrl(user, password, db) {
  const u = new URL(admin);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  u.search = '';
  u.searchParams.set('sslmode', sslmode);
  if (ca) u.searchParams.set('sslrootcert', ca);
  return u.toString();
}

/** URL for the Prisma CLI schema engine (its own TLS parameters). */
function prismaUrl(user, password, db) {
  const u = new URL(admin);
  u.username = user;
  u.password = password;
  u.pathname = `/${db}`;
  u.search = '';
  if (sslmode === 'disable') return u.toString();
  u.searchParams.set('sslmode', 'require');
  u.searchParams.set('sslcert', ca);
  u.searchParams.set('sslaccept', 'strict');
  return u.toString();
}

/** libpq URL for psql inside Docker (CA mounted at /ca.crt). */
function psqlUrl(db) {
  const u = new URL(admin);
  u.pathname = `/${db}`;
  u.search = '';
  u.searchParams.set('sslmode', sslmode);
  if (ca) u.searchParams.set('sslrootcert', '/ca.crt');
  // Local rehearsal: reach the host's database from inside the psql container.
  if (['127.0.0.1', 'localhost'].includes(u.hostname)) u.hostname = 'host.docker.internal';
  return u.toString();
}

/** Runs a command, streaming its scrubbed output line by line to the console and run.log. */
function run(label, cmd, args, { env = {}, input } = {}) {
  return new Promise((done) => {
    const t = Date.now();
    note(`\n### ${label} (started ${new Date(t).toISOString()})`);
    const child = spawn(cmd, args, {
      shell: process.platform === 'win32' && cmd === 'pnpm',
      env: { ...process.env, ...env },
    });
    let stdout = '';
    const pipe = (stream, keep) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          if (keep) stdout += `${l}\n`;
          note(l.replace(/\r$/, ''));
        }
      });
      stream.on('end', () => {
        if (!buf) return;
        if (keep) stdout += buf;
        note(buf);
      });
    };
    pipe(child.stdout, true);
    pipe(child.stderr, false);
    child.stdin.end(input ?? '');
    child.on('error', (e) => note(`spawn error: ${e.message}`));
    child.on('close', (code) => {
      const ms = Date.now() - t;
      note(`### ${label} (exit ${code}, ${(ms / 1000).toFixed(1)} s)`);
      done({ status: code, ms, stdout: scrub(stdout) });
    });
  });
}

function psql(label, db, sql, vars = {}) {
  // Values travel as environment variables, never on the command line.
  const env = { PGURL: psqlUrl(db) };
  const dockerArgs = ['run', '--rm', '-i', '-e', 'PGURL'];
  if (ca) dockerArgs.push('-v', `${ca}:/ca.crt:ro`);
  const psqlVars = [];
  for (const [k, v] of Object.entries(vars)) {
    env[`V_${k}`] = v;
    dockerArgs.push('-e', `V_${k}`);
    psqlVars.push(`-v ${k}="$V_${k}"`);
  }
  dockerArgs.push(
    PSQL_IMAGE,
    'sh',
    '-c',
    `psql "$PGURL" -v ON_ERROR_STOP=1 -qtA ${psqlVars.join(' ')} -f -`,
  );
  return run(label, 'docker', dockerArgs, { env, input: sql });
}

/** SQL over node-postgres (same TLS as the tests): rows + notices. */
async function sqlAs(label, url, statements) {
  const r = await run(label, 'node', ['scripts/managed-db/sql-json.mjs'], {
    env: { U: url, Q: JSON.stringify(statements) },
  });
  let out = {};
  try {
    out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  } catch {
    // failure is visible in the status and the log
  }
  return { status: r.status, ...out };
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Every policy, so a temporary mutation can be shown to be fully removed.
const POLICY_FINGERPRINT = `SELECT count(*)::int AS policies, md5(string_agg(concat_ws('|',
  schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check), ';'
  ORDER BY schemaname, tablename, policyname)) AS fingerprint FROM pg_policies`;

// Roles with power beyond RLS and grants: elevated attributes, these predefined roles, and any
// role that is a member of one (e.g. Neon's neon_superuser). Keep in step with
// PREDEFINED_PRIVILEGED in tests/integration/db-roles.test.ts.
const PRIVILEGED_ROLES = `WITH p AS (
    SELECT oid FROM pg_roles
    WHERE rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
       OR rolname IN ('pg_read_all_data', 'pg_write_all_data', 'pg_read_server_files',
         'pg_write_server_files', 'pg_execute_server_program', 'pg_signal_backend',
         'pg_signal_autovacuum_worker', 'pg_maintain', 'pg_checkpoint', 'pg_create_subscription',
         'pg_use_reserved_connections', 'pg_monitor', 'pg_read_all_settings', 'pg_read_all_stats'))
  SELECT r.oid, r.rolname FROM pg_roles r
  WHERE r.oid IN (SELECT oid FROM p) OR EXISTS (SELECT 1 FROM p WHERE pg_has_role(r.oid, p.oid, 'MEMBER'))`;

// Post-run state of roles, database privileges and RLS (run as crm_migrator in each database).
const FINAL_CHECKS = [
  `SELECT current_database() AS db, pg_get_userbyid(datdba) AS owner,
     has_database_privilege('public', current_database(), 'CONNECT') AS public_can_connect,
     has_database_privilege('public', current_database(), 'TEMP') AS public_can_temp
   FROM pg_database WHERE datname = current_database()`,
  `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
   FROM pg_roles WHERE rolname LIKE 'crm\\_%' ORDER BY 1`,
  `SELECT r.rolname AS role, m.rolname AS member, a.admin_option, a.inherit_option, a.set_option
   FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
   WHERE r.rolname LIKE 'crm\\_%' OR m.rolname LIKE 'crm\\_%' ORDER BY 1, 2`,
  `SELECT count(*)::int AS org_tables,
     count(*) FILTER (WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity))::int AS without_forced_rls
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND EXISTS (SELECT 1 FROM pg_attribute a
     WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)`,
  `SELECT count(*)::int AS mutation_policies_left FROM pg_policies WHERE policyname LIKE 's1\\_mutation%'`,
  POLICY_FINGERPRINT,
  // Privileged roles present (must include the provider admin) ...
  `SELECT rolname FROM (${PRIVILEGED_ROLES}) x ORDER BY 1`,
  // ... and every crm_* role that could assume one of them (must be none).
  `SELECT a.rolname AS role, x.rolname AS privileged FROM pg_roles a, (${PRIVILEGED_ROLES}) x
   WHERE a.rolname IN ('crm_app', 'crm_auth', 'crm_platform', 'crm_migrator', 'crm_definer')
     AND a.oid <> x.oid AND pg_has_role(a.oid, x.oid, 'MEMBER') ORDER BY 1, 2`,
];

/** DO block that times `sql` inside the server (no network): 20 warm-up + 200 runs. */
function serverTimed(label, sql) {
  const exec = lit(`SELECT count(*) FROM (${sql}) s`);
  return `DO $t$ DECLARE t timestamptz; d float8[] := '{}'; n int; BEGIN
    FOR i IN 1..220 LOOP
      t := clock_timestamp(); EXECUTE ${exec} INTO n;
      IF i > 20 THEN d := d || (extract(epoch FROM clock_timestamp() - t) * 1000)::float8; END IF;
    END LOOP;
    RAISE NOTICE '%', json_build_object('query', ${lit(label)}, 'rows', n,
      'p50_ms', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY x)::numeric, 3) FROM unnest(d) x),
      'p95_ms', (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY x)::numeric, 3) FROM unnest(d) x));
  END $t$`;
}

// --- checkpoint state --------------------------------------------------------------------------

const now = () => new Date().toISOString();
const state = RESUME
  ? JSON.parse(readFileSync(STATE, 'utf8'))
  : {
      label: LABEL,
      dir: DIR,
      createdAt: now(),
      host: adminUrl.hostname,
      sslmode,
      rehearsal: process.env.MANAGED_REHEARSAL === '1',
      target: TARGET,
      adminRole: decodeURIComponent(adminUrl.username),
      diagnosticOverride: DIAG,
      invocations: [],
      steps: {},
      batches: {},
      plan: [],
    };
// A diagnostic run and a binding run never share a directory.
if (RESUME && JSON.stringify(state.diagnosticOverride ?? null) !== JSON.stringify(DIAG))
  throw new Error('resume refused: the diagnostic override differs from the run being resumed');
state.adminRole ??= decodeURIComponent(adminUrl.username);
state.invocations.push({ startedAt: now(), mode: RESUME ? 'resume' : 'fresh' });

function save() {
  writeFileSync(`${STATE}.tmp`, `${scrub(JSON.stringify(state, null, 2))}\n`);
  renameSync(`${STATE}.tmp`, STATE);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    state.invocations.at(-1).interruptedAt = now();
    state.invocations.at(-1).signal = sig;
    save();
    note(`\nInterrupted (${sig}). Progress is saved in ${DIR}. Resume: see the run instructions.`);
    process.exit(130);
  });
}
save();
note(`Run directory: ${DIR} (${RESUME ? 'resume' : 'fresh'})`);

/** A step records {status: running} first, then done/failed, so an interruption is visible. */
async function step(name, fn) {
  const startedAt = now();
  state.steps[name] = { status: 'running', startedAt };
  save();
  let rec;
  try {
    rec = await fn();
  } catch (e) {
    rec = { ok: false, error: scrub(e.message) };
  }
  const { ok, ...details } = rec;
  state.steps[name] = { status: ok ? 'done' : 'failed', startedAt, endedAt: now(), ...details };
  save();
  return ok;
}

// --- setup (fresh runs only) -----------------------------------------------------------------

const SETUP = [
  'serverInfo',
  'createDatabases',
  'bootstrap_crm_s1',
  'bootstrap_crm_test',
  'migrateS1',
  'migrateProduction',
  'baselineGrant',
];
const lines = (r) => r.stdout.trim().split('\n').filter(Boolean);

const s1Env = {
  S1_APP_URL: nodeUrl('crm_app', pw.app, 'crm_s1'),
  S1_MIGRATOR_URL: nodeUrl('crm_migrator', pw.migrator, 'crm_s1'),
  S1_PLATFORM_URL: nodeUrl('crm_platform', pw.platform, 'crm_s1'),
  S1_BASELINE_URL: nodeUrl(adminUrl.username, decodeURIComponent(adminUrl.password), 'crm_s1'),
};
const dbRolesEnv = {
  TEST_DATABASE_URL: nodeUrl('crm_app', pw.app, 'crm_test'),
  TEST_AUTH_DATABASE_URL: nodeUrl('crm_auth', pw.auth, 'crm_test'),
  TEST_PLATFORM_DATABASE_URL: nodeUrl('crm_platform', pw.platform, 'crm_test'),
  TEST_MIGRATOR_URL: nodeUrl('crm_migrator', pw.migrator, 'crm_test'),
  // db-roles: the provider admin must be among the privileged roles the app roles cannot reach.
  TEST_PROVIDER_ADMIN_ROLE: decodeURIComponent(adminUrl.username),
  // The Neon target neon-s1.mjs verified. db-roles trusts it only after the server itself reports
  // this branch and endpoint (tests/support/neon-context.ts); then Neon's own refusal of its
  // protected roles may count, nothing else.
  ...(TARGET?.provider === 'Neon'
    ? {
        TEST_NEON_BRANCH_ID: TARGET.branchId,
        TEST_NEON_ENDPOINT_ID: TARGET.endpointId,
        TEST_NEON_PRODUCTION_BRANCH_IDS: (TARGET.productionBranchIds ?? []).join(','),
      }
    : {}),
};

if (!RESUME) {
  let ok = await step('serverInfo', async () => {
    const r = await psql(
      'server info',
      adminDb,
      "SELECT version(); SHOW server_version; SELECT current_user, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user; SHOW ssl; SELECT name, default_version FROM pg_available_extensions WHERE name IN ('citext','btree_gist','pg_trgm') ORDER BY 1;",
    );
    return { ok: r.status === 0, output: lines(r) };
  });
  ok &&= await step('createDatabases', async () => {
    const r = await psql(
      'create databases',
      adminDb,
      "SELECT 'CREATE DATABASE crm_s1' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='crm_s1') \\gexec\nSELECT 'CREATE DATABASE crm_test' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='crm_test') \\gexec\n",
    );
    return { ok: r.status === 0 };
  });
  const bootstrapSql = readFileSync('scripts/db/bootstrap-managed-roles.sql', 'utf8');
  for (const db of ['crm_s1', 'crm_test']) {
    ok &&= await step(`bootstrap_${db}`, async () => {
      const r = await psql(`bootstrap roles (${db})`, adminDb, bootstrapSql, {
        db,
        migrator_pw: pw.migrator,
        app_pw: pw.app,
        auth_pw: pw.auth,
        platform_pw: pw.platform,
      });
      if (r.status !== 0)
        note(`BOOTSTRAP FAILED on ${db}: S1-18 fails at role creation (runbook §1.2).`);
      return { ok: r.status === 0, output: lines(r) };
    });
  }
  ok &&= await step('migrateS1', async () => {
    const r = await run('migrate S1 schema (crm_migrator)', 'pnpm', ['spike:s1:migrate'], {
      env: { S1_MIGRATOR_URL: prismaUrl('crm_migrator', pw.migrator, 'crm_s1') },
    });
    return { ok: r.status === 0, seconds: r.ms / 1000 };
  });
  ok &&= await step('migrateProduction', async () => {
    const r = await run('migrate production schema (crm_migrator)', 'pnpm', ['db:migrate'], {
      env: { DATABASE_MIGRATOR_URL: prismaUrl('crm_migrator', pw.migrator, 'crm_test') },
    });
    return { ok: r.status === 0, seconds: r.ms / 1000 };
  });
  // S1-17's "without RLS" baseline reads as the provider admin (BYPASSRLS). The bootstrap
  // correctly gives it no access to the database, so the owner grants read access in this
  // throwaway spike database only. The application roles are unchanged.
  ok &&= await step('baselineGrant', async () => {
    const a = `"${decodeURIComponent(adminUrl.username).replace(/"/g, '""')}"`;
    const r = await sqlAs('grant baseline read (as crm_migrator)', s1Env.S1_MIGRATOR_URL, [
      `GRANT CONNECT ON DATABASE crm_s1 TO ${a}`,
      `GRANT USAGE ON SCHEMA public TO ${a}`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${a}`,
    ]);
    return { ok: r.status === 0 };
  });
  // Static listing, for reporting batches that never start (it.each cases count once here).
  if (ok) {
    await run(
      'plan: list S1 tests',
      'pnpm',
      [
        'exec',
        'vitest',
        'list',
        '--project',
        's1',
        'spikes/s1-tenant-isolation/tests',
        `--json=${resolve(DIR, 'plan-s1.json')}`,
      ],
      { env: s1Env },
    );
    await run(
      'plan: list db-roles tests',
      'pnpm',
      [
        'exec',
        'vitest',
        'list',
        '--project',
        'integration',
        'tests/integration/db-roles.test.ts',
        `--json=${resolve(DIR, 'plan-db-roles.json')}`,
      ],
      { env: dbRolesEnv },
    );
  }
} else {
  const unfinished = SETUP.filter((s) => state.steps[s]?.status !== 'done');
  if (unfinished.length) {
    note(`Setup did not finish (${unfinished.join(', ')}): not resumable. Clean and start again.`);
    process.exit(1);
  }
  // The roles exist; their earlier passwords died with the stopped process.
  await step('resetPasswords', async () => {
    const r = await psql(
      'new passwords for the generated roles (resume)',
      adminDb,
      `ALTER ROLE crm_migrator PASSWORD :'migrator_pw';
ALTER ROLE crm_app PASSWORD :'app_pw';
ALTER ROLE crm_auth PASSWORD :'auth_pw';
ALTER ROLE crm_platform PASSWORD :'platform_pw';
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'crm\\_%' ORDER BY 1;`,
      { migrator_pw: pw.migrator, app_pw: pw.app, auth_pw: pw.auth, platform_pw: pw.platform },
    );
    return { ok: r.status === 0, output: lines(r) };
  });
  if (state.steps.resetPasswords.status !== 'done') process.exit(1);
}

const setupOk = SETUP.every((s) => state.steps[s]?.status === 'done');

// Round trip from the test machine, per invocation, for reading the S1-17 latencies.
if (setupOk) {
  const rtt = await run(
    'round-trip time',
    'node',
    [
      '-e',
      `const pg=require('pg');(async()=>{const c=new pg.Client({connectionString:process.env.U});await c.connect();
    const t=[];for(let i=0;i<20;i++){const s=performance.now();await c.query('select 1');t.push(performance.now()-s)}
    t.sort((a,b)=>a-b);console.log(JSON.stringify({p50:+t[10].toFixed(1),max:+t[19].toFixed(1)}));await c.end()})()`,
    ],
    { env: { U: s1Env.S1_APP_URL } },
  );
  state.invocations.at(-1).roundTripMs = rtt.stdout.trim();
  // A mutation policy can survive only if an earlier invocation stopped mid-check.
  const leftover = await sqlAs('remove any leftover mutation policy', s1Env.S1_MIGRATOR_URL, [
    `SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 's1_mutation_permissive'`,
    'DROP POLICY IF EXISTS s1_mutation_permissive ON lead',
  ]);
  state.invocations.at(-1).leftoverMutationPolicies = leftover.results?.[0]?.[0]?.n ?? null;
  save();
}

// --- batches --------------------------------------------------------------------------------

const S1 = 'spikes/s1-tenant-isolation/tests/';
const pooledUrl = (() => {
  if (!process.env.MANAGED_POOL_NAME && !process.env.MANAGED_POOL_HOST) return null;
  // crm_app's password exists only in this process, so the pool uses "inbound user".
  const u = new URL(s1Env.S1_APP_URL);
  if (process.env.MANAGED_POOL_HOST) {
    u.hostname = process.env.MANAGED_POOL_HOST;
  } else {
    u.port = process.env.MANAGED_POOL_PORT ?? '25061';
    u.pathname = `/${process.env.MANAGED_POOL_NAME}`;
  }
  return u.toString();
})();

const BATCHES = [
  { name: 's1-01-02', files: [`${S1}s1-01-02-catalog.test.ts`] },
  { name: 's1-03-07', files: [`${S1}s1-03-07-isolation.test.ts`] },
  { name: 's1-08', files: [`${S1}s1-08-concurrency.test.ts`] },
  { name: 's1-09', files: [`${S1}s1-09-lint-and-raw-client.test.ts`] },
  { name: 's1-10-12', files: [`${S1}s1-10-12-access-paths.test.ts`] },
  { name: 's1-13-14', files: [`${S1}s1-13-14-definer-and-platform.test.ts`] },
  { name: 's1-15-16', files: [`${S1}s1-15-16-scope-and-history.test.ts`] },
  { name: 's1-17', files: [`${S1}s1-17-performance.test.ts`] },
  ...(process.env.MANAGED_SERVER_TIMING === '1'
    ? [{ name: 'server-timing', kind: 'check', after: 's1-17', fn: serverTiming }]
    : []),
  ...(pooledUrl
    ? [
        { name: 'pooled-s1-08', files: [`${S1}s1-08-concurrency.test.ts`], pooled: true },
        { name: 'pooled-s1-03-07', files: [`${S1}s1-03-07-isolation.test.ts`], pooled: true },
      ]
    : []),
  ...(process.env.MANAGED_MUTATION_CHECK === '1'
    ? [{ name: 'mutation', kind: 'check', fn: mutationCheck }]
    : []),
  { name: 'db-roles', files: ['tests/integration/db-roles.test.ts'], project: 'integration' },
];
if (!RESUME)
  state.plan = BATCHES.map(({ name, files, project, kind, pooled }) => ({
    name,
    kind: kind ?? 'tests',
    files: files ?? [],
    project: project ?? (files ? 's1' : null),
    pooled: !!pooled,
  }));
const selected = process.env.MANAGED_BATCHES?.split(',').map((s) => s.trim());
state.invocations.at(-1).selected = selected ?? 'all';
save();

async function vitest(b, attempt, batchName = b.name) {
  // Diagnostic values last: S1_DIAG_* and the diagnostic S1_CONNECTION_TIMEOUT_MS replace any
  // ambient value, and only for the two selected S1-08 batches of an authorized diagnostic.
  const env = withDiagnosticEnv(
    {
      ...(b.project === 'integration' ? dbRolesEnv : s1Env),
      ...(b.pooled ? { S1_APP_URL: pooledUrl } : {}),
      // S1-08 picks its pooled assertions only from this (and checks the endpoint differs);
      // set for every S1 batch so an ambient value can never reach a direct batch.
      ...(b.project === 'integration' ? {} : { S1_APP_POOLED: b.pooled ? '1' : '0' }),
      CHECKPOINT_FILE: TESTS,
      CHECKPOINT_BATCH: batchName,
      CHECKPOINT_ATTEMPT: String(attempt),
    },
    batchName,
    DIAG,
  );
  const diagnosticSettings = diagnosticSettingsOf(env);
  if (diagnosticSettings) {
    // Recorded before the batch starts, so an interrupted batch still shows its configuration.
    state.batches[batchName] = { ...state.batches[batchName], diagnosticSettings };
    save();
  }
  const r = await run(
    `batch ${batchName} (attempt ${attempt})`,
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--project',
      b.project ?? 's1',
      ...b.files,
      '--reporter=default',
      `--reporter=${REPORTER}`,
      ...(process.env.MANAGED_TEST_TIMEOUT_MS
        ? [`--testTimeout=${process.env.MANAGED_TEST_TIMEOUT_MS}`]
        : []),
    ],
    { env },
  );
  return { exit: r.status, seconds: r.ms / 1000, summary: summarise(batchName, attempt) };
}

/** Counts from tests.jsonl for one batch attempt (the checkpoint, not vitest's own report). */
function summarise(batch, attempt) {
  const events = existsSync(TESTS)
    ? readFileSync(TESTS, 'utf8')
        .split('\n')
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
        .filter((e) => e.batch === batch && e.attempt === attempt)
    : [];
  const results = new Map(events.filter((e) => e.type === 'result').map((e) => [e.id, e]));
  const collected = new Set(events.filter((e) => e.type === 'collected').map((e) => e.id));
  const count = (s) => [...results.values()].filter((e) => e.state === s).length;
  return {
    collected: collected.size,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped') + count('pending'),
    noResult: [...collected].filter((id) => !results.has(id)).length,
    failures: [...results.values()].filter((e) => e.state === 'failed').map((e) => e.name),
  };
}

async function serverTiming() {
  // Supplementary to S1-17: the same list queries timed inside the server, so the test
  // machine's round trip is excluded. RLS (crm_app + context) vs baseline (admin + predicate).
  const ids = (
    await sqlAs('perf org ids (as crm_migrator)', s1Env.S1_MIGRATOR_URL, [
      `SELECT o.id::text AS org, array(SELECT DISTINCT owner_user_id::text FROM lead
         WHERE org_id = o.id ORDER BY 1 LIMIT 5) AS owners
       FROM organization o WHERE o.name = 'PERF-250k'`,
    ])
  ).results?.[0]?.[0];
  if (!ids || !UUID.test(ids.org) || !ids.owners.every((o) => UUID.test(o)))
    return { ok: false, error: 'perf org not found (S1-17 seeds it)' };
  const cols = 'SELECT id, full_name, owner_user_id, created_at FROM lead';
  const order = 'ORDER BY created_at DESC, id DESC LIMIT 50';
  const owners = `owner_user_id = ANY('{${ids.owners.join(',')}}'::uuid[])`;
  const org = `org_id = '${ids.org}'::uuid`;
  const rls = await sqlAs('server-side timing, RLS (crm_app)', s1Env.S1_APP_URL, [
    'BEGIN',
    `SELECT set_config('app.org_id', '${ids.org}', true)`,
    serverTimed('own (5 owners)', `${cols} WHERE ${owners} ${order}`),
    serverTimed('org-wide', `${cols} ${order}`),
    'COMMIT',
  ]);
  const base = await sqlAs('server-side timing, baseline (admin)', s1Env.S1_BASELINE_URL, [
    serverTimed('own (5 owners)', `${cols} WHERE ${org} AND ${owners} ${order}`),
    serverTimed('org-wide', `${cols} WHERE ${org} ${order}`),
  ]);
  const parse = (r) => (r.notices ?? []).map((n) => JSON.parse(n));
  return { ok: rls.status === 0 && base.status === 0, rls: parse(rls), baseline: parse(base) };
}

async function mutationCheck(attempt) {
  // Negative control: with a permissive policy S1-03…07 must fail. Removed in `finally`, then
  // the policy set must match the fingerprint taken before, and S1-03…07 pass again.
  const isolation = { files: [`${S1}s1-03-07-isolation.test.ts`] };
  const before = await sqlAs('policies before mutation', s1Env.S1_MIGRATOR_URL, [
    POLICY_FINGERPRINT,
  ]);
  const m = { before: before.results?.[0]?.[0] ?? null };
  try {
    const applied = await sqlAs('apply mutation: permissive policy', s1Env.S1_MIGRATOR_URL, [
      'CREATE POLICY s1_mutation_permissive ON lead FOR SELECT TO crm_app USING (true)',
    ]);
    m.applied = applied.status === 0;
    state.batches.mutation.policyApplied = m.applied;
    save();
    if (m.applied) m.mutated = (await vitest(isolation, attempt, 'mutation-permissive')).summary;
  } finally {
    const after = await sqlAs('remove mutation', s1Env.S1_MIGRATOR_URL, [
      'DROP POLICY IF EXISTS s1_mutation_permissive ON lead',
      POLICY_FINGERPRINT,
    ]);
    m.after = after.results?.[1]?.[0] ?? null;
    state.batches.mutation.policyApplied = after.status === 0 ? false : 'unknown';
    save();
  }
  m.detected = (m.mutated?.failed ?? 0) > 0;
  m.restored = m.before?.fingerprint != null && m.before.fingerprint === m.after?.fingerprint;
  m.reverified = (await vitest(isolation, attempt, 'mutation-restored')).summary;
  return {
    ok: m.detected && m.restored && m.reverified.failed === 0 && m.reverified.passed > 0,
    ...m,
  };
}

const prereqs = (b) =>
  b.project === 'integration' ? ['migrateProduction'] : ['migrateS1', 'baselineGrant'];

/**
 * Diagnostic override only, before the first S1-08 batch: as the admin, the direct and the
 * pooled path must both report the verified test branch and endpoint (fail closed otherwise).
 */
async function diagnosticServerCheck() {
  if (state.diagnosticServerCheck?.ok) return state.diagnosticServerCheck;
  const urls = { direct: s1Env.S1_BASELINE_URL };
  if (pooledUrl) {
    const u = new URL(s1Env.S1_BASELINE_URL);
    u.hostname = new URL(pooledUrl).hostname;
    urls.pooled = u.toString();
  }
  const seen = {};
  for (const [path, url] of Object.entries(urls)) {
    const r = await sqlAs(`diagnostic override: target check (${path}, admin)`, url, [
      `SELECT current_setting('neon.branch_id', true) AS branch,
         current_setting('neon.endpoint_id', true) AS endpoint`,
    ]);
    seen[path] = r.results?.[0]?.[0] ?? null;
  }
  const ok = Object.values(seen).every(
    (x) =>
      x?.branch === DIAG.branchId &&
      x?.endpoint === DIAG.endpointId &&
      !DIAG.productionBranchIds.includes(x.branch),
  );
  state.diagnosticServerCheck = { ok, at: now(), seen };
  save();
  return state.diagnosticServerCheck;
}

for (const b of BATCHES) {
  const prev = state.batches[b.name];
  if (prev?.status === 'done') {
    note(`\n(batch ${b.name}: finished in an earlier invocation, not re-run)`);
    continue;
  }
  if (selected && !selected.includes(b.name)) {
    if (!prev) state.batches[b.name] = { status: 'not selected' };
    continue;
  }
  const missing = prereqs(b).filter((s) => state.steps[s]?.status !== 'done');
  if (b.after && state.batches[b.after]?.status !== 'done') missing.push(`batch ${b.after}`);
  if (missing.length) {
    state.batches[b.name] = { status: 'blocked', reason: `prerequisite not done: ${missing}` };
    save();
    continue;
  }
  if (DIAG?.appliesTo.includes(b.name) && !(await diagnosticServerCheck()).ok) {
    state.batches[b.name] = {
      status: 'blocked',
      reason: 'diagnostic override refused: the server did not report the verified test branch',
    };
    save();
    continue;
  }
  const attempt = (prev?.attempts ?? 0) + 1;
  const startedAt = now();
  state.batches[b.name] = { status: 'running', attempts: attempt, startedAt };
  save();
  const res = b.kind === 'check' ? await b.fn(attempt) : await vitest(b, attempt);
  state.batches[b.name] = {
    ...state.batches[b.name],
    ...res,
    status: 'done',
    attempts: attempt,
    startedAt,
    endedAt: now(),
  };
  save();
}

if (setupOk) {
  state.finalVerification = { at: now() };
  for (const db of ['crm_s1', 'crm_test']) {
    const r = await sqlAs(
      `final verification (${db})`,
      nodeUrl('crm_migrator', pw.migrator, db),
      FINAL_CHECKS,
    );
    state.finalVerification[db] = { status: r.status, results: r.results ?? null };
  }
}
state.invocations.at(-1).endedAt = now();
save();

const report = buildReport(DIR);
note(`\n${report.headline}`);
note(`results: ${DIR}/report.md`);
// Failed, blocked, interrupted or unrun selected work must not exit 0 (neon-s1.mjs passes this
// code on). The report stays the authority for counts and for the S1 verdict (bindingPass).
const exit = runExitStatus(state, report);
note(
  exit.code === 0
    ? `exit 0: every selected batch and check passed. Binding S1 pass: ${report.bindingPass ? 'yes' : 'no'}${report.diagnosticOverride ? ' (diagnostic run: never binding)' : ''}.`
    : `exit 1: ${exit.problems.join('; ')}`,
);
process.exitCode = exit.code;
