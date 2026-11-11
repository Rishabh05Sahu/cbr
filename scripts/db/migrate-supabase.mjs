#!/usr/bin/env node
// Applies the reviewed Prisma migrations to the Supabase acceptance project as crm_migrator, one
// psql transaction per migration, then records each with `prisma migrate resolve --applied`
// (docs/runbooks/supabase-free-setup.md §6). Why not `prisma migrate deploy`: Prisma 7 does not
// roll back a migration that fails partway (verified offline), which on Supabase would need manual
// cleanup; here a failing migration leaves nothing behind.
//
//   node scripts/db/migrate-supabase.mjs --status
//       READ ONLY: one psql READ ONLY transaction, rolled back (target, TLS, applied, pending and
//       inconsistent migration history), then `prisma migrate status` to prove Prisma connects
//       with strict TLS (SELECTs only; verified offline). Never runs DDL or migration SQL.
//       --deploy runs it first, so a Prisma TLS failure stops before anything is committed.
//   node scripts/db/migrate-supabase.mjs --verify
//       READ ONLY, after --deploy: scans scripts/db/verify-supabase.sql for anything that could
//       write (refuses to run it if so), runs --status, then runs the file as crm_migrator inside
//       BEGIN TRANSACTION READ ONLY ... ROLLBACK. Every check 1-14 must appear once with ok = t,
//       and the CRM tables must be exactly the migrations' 27 plus _crm_migration_marker.
//   node scripts/db/migrate-supabase.mjs --deploy
//       Applies every pending migration in order; stops at the first problem.
//   node scripts/db/migrate-supabase.mjs --record-committed <migration>
//       Recovery only, after review: records a migration whose SQL committed but whose Prisma
//       record is missing (see "Crash gap" below). Never runs migration SQL.
//
// --target qa|prod reads the same variables from .env.supabase-qa / .env.supabase-prod instead
// (acceptance-env.mjs loadTargetEnv); --deploy and --record-committed on prod first ask for a
// backup confirmation and the typed project ref (confirmProduction).
//
// Target: ONLY ACCEPTANCE_DATABASE_MIGRATOR_URL from .env, after the full acceptance validation
// (acceptance-env.mjs: project ref, pooler host, port 5432, database postgres, user
// crm_migrator.<ref>, password, CA file). The unprefixed DATABASE_MIGRATOR_URL (the local
// database) is never read: Prisma runs with prisma.supabase.config.mjs, which does not load .env,
// and a child environment built from scratch.
//
// TLS: psql runs in a throwaway container with sslmode=verify-full against the CA file mounted
// read-only (dockerPsql). Prisma's schema engine ignores sslmode=verify-full (verified offline:
// it connects without verifying), so its URL is rebuilt as sslmode=require&sslcert=<CA>&
// sslaccept=strict, which verifies the chain and the host name (verified offline). The acceptance
// URL may carry only sslmode (validated), so no other parameter is dropped.
//
// Per migration, ONE transaction: an advisory lock; a check that the recorded history is exactly
// the migrations before this one; the unchanged migration.sql; a row in
// public._crm_migration_marker. Then, after COMMIT, Prisma records it, and the ledger is read back.
//
// Crash gap: if the SQL committed but Prisma did not record it (error, crash, lost connection),
// the marker row exists without a ledger row. Every run checks for that first and stops: it never
// re-runs a committed migration. Review, then `--record-committed <migration>`.
//
// Concurrency: an exclusive lock file stops a second run of this wrapper on this machine, and the
// in-transaction advisory lock plus history check stops a second run elsewhere from applying the
// same migration twice. Neither stops other tools (prisma migrate, psql) from changing the
// database.
//
// Output names migrations, checks and SQLSTATE-level errors; never a URL, password, host or ref.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CA_GUARD_EXIT,
  confirmProduction,
  dockerPsql,
  loadTargetEnv,
  maskRef,
  takeTarget,
  validateAcceptance,
} from './acceptance-env.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(REPO, 'prisma', 'migrations');
const PRISMA_CLI = join(REPO, 'node_modules', 'prisma', 'build', 'index.js');
const PRISMA_CONFIG = join(REPO, 'scripts', 'db', 'prisma.supabase.config.mjs');
const LOCK_PATH = join(tmpdir(), 'crm-migrate-supabase.lock');
const ADVISORY_KEY = "hashtextextended('crm-migrate-supabase', 0)";
export const MARKER_TABLE = 'public._crm_migration_marker';

/** The reviewed migrations (2026-10-27): names in order and the SHA-256 of each migration.sql. */
export const MANIFEST = [
  ['0001_foundation', '75d334b081bebcee721769713ef42cdccab56e022b4a58e0f99b13db390020b7'],
  ['0002_security', '73a484865958997e60af3d278d32ed92270440e0fd0cc50bc088315b65d6fd76'],
  ['0003_leads', '86e37cc63e61a4a49723cd1cf364d8c9e788bac606c9e3a4e45367382d0f8d6f'],
  ['0004_assignment', '095fe78b14d77bce328c54229306612fcca674f540131bf769da9fa1e0caa403'],
  ['0005_imports', '4a7b2eba4b97ea0cd37baa051c75dc49389160162df6b5324e83edb9630ee75b'],
  ['0006_hygiene', 'a019aac34d98efa8052aa017e84ec13bfe6c49036ef798d8652d87d072fcadcd'],
  [
    '0007_lead_email_normalized',
    '4f26dbdc82a7c581a1020723d30d335046c02912abe7b9b879976ff2483d4936',
  ],
  ['0008_lead_name_sort_index', 'd241074bcf2db17869cb05de0d610a95f05659c88d6ff6860acb789d671cbabb'],
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------------------------
// Static checks of a migration file

/**
 * Blanks comments, string literals (standard, E'' and dollar-quoted) and quoted identifiers so
 * that only SQL structure remains. Returns null if a quote or comment is left open.
 */
export function sqlStructure(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? n : end;
      out += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) return null;
      out += ' ';
    } else if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '');
      i++;
      for (;;) {
        if (i >= n) return null;
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      out += "''";
    } else if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      if (end < 0) return null;
      i = end + 1;
      out += '""';
    } else if (c === '$' && !/[\w$]/.test(sql[i - 1] ?? '')) {
      const tag = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
      if (!tag) {
        out += c;
        i++;
        continue;
      }
      const end = sql.indexOf(tag[0], i + tag[0].length);
      if (end < 0) return null;
      i = end + tag[0].length;
      out += ' $$ ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Problems that make a file unsafe to run unchanged through psql in one transaction. */
export function migrationProblems(sql) {
  const s = sqlStructure(sql);
  if (s === null) return ['unterminated quote, dollar quote or comment'];
  const problems = [];
  if (s.includes('\\'))
    problems.push('a backslash outside literals (psql would run it as a meta-command)');
  if (/(^|[^:\w]):(['"]?)[A-Za-z_]/.test(s))
    problems.push('a psql variable reference (:name) outside literals');
  const statements = s
    .split(';')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  for (const st of statements) {
    if (
      /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION|END|ABORT|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED)\b/.test(
        st,
      )
    )
      problems.push(`transaction control: ${st.split(/\s+/).slice(0, 2).join(' ')}`);
    if (
      /^(VACUUM|CHECKPOINT|CLUSTER|REINDEX\s+(SYSTEM|DATABASE))\b/.test(st) ||
      /\bCONCURRENTLY\b/.test(st)
    )
      problems.push(`not allowed in a transaction: ${st.split(/\s+/).slice(0, 3).join(' ')}`);
    if (/^(CREATE|DROP|ALTER)\s+DATABASE\b|^ALTER\s+SYSTEM\b/.test(st))
      problems.push(
        `database- or server-level statement: ${st.split(/\s+/).slice(0, 2).join(' ')}`,
      );
    if (/^ALTER\s+TYPE\b.*\bADD\s+VALUE\b/.test(st))
      problems.push('ALTER TYPE ... ADD VALUE (the new value is unusable in the same transaction)');
  }
  if (!/;\s*$/.test(s)) problems.push('the file does not end with a semicolon');
  return problems;
}

/** Reads the migrations directory and checks it against the manifest. */
export function loadMigrations(dir = MIGRATIONS_DIR, manifest = MANIFEST) {
  const problems = [];
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const names = manifest.map(([name]) => name);
  const unreviewed = dirs.filter((d) => !names.includes(d));
  // A newer migration is not deployable here until it is reviewed and pinned in MANIFEST.
  if (unreviewed.length)
    problems.push(
      `unreviewed migration directories present (${unreviewed.join(', ')}); pin them in MANIFEST after review before using this wrapper`,
    );
  if (names.some((n) => !dirs.includes(n)))
    problems.push(`migration directories differ from the reviewed list (${names.length} expected)`);
  const migrations = [];
  for (const [name, expected] of manifest) {
    const file = join(dir, name, 'migration.sql');
    if (!existsSync(file)) {
      problems.push(`${name}: migration.sql missing`);
      continue;
    }
    const buf = readFileSync(file);
    const checksum = sha256(buf);
    if (checksum !== expected) problems.push(`${name}: changed since review (SHA-256 differs)`);
    for (const p of migrationProblems(buf.toString('utf8'))) problems.push(`${name}: ${p}`);
    migrations.push({ name, checksum, sql: buf.toString('utf8') });
  }
  return { migrations, problems };
}

// ---------------------------------------------------------------------------------------------
// Target and connections

/**
 * The migration target from the .env variables, after the full acceptance validation. Reads
 * ACCEPTANCE_DATABASE_MIGRATOR_URL only; throws (naming variables, never values) otherwise.
 */
export function migratorTarget(env) {
  const { errors, target } = validateAcceptance(env, 'all');
  if (errors.length)
    throw new Error(`acceptance configuration is not valid:\n  - ${errors.join('\n  - ')}`);
  const raw = (env.ACCEPTANCE_DATABASE_MIGRATOR_URL ?? '').trim();
  const u = new URL(raw);
  const t = {
    ref: target.ref,
    host: u.hostname,
    port: u.port || '5432',
    database: u.pathname.slice(1),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    caPath: target.admin.caPath,
  };
  const wrong = [];
  if (t.user !== `crm_migrator.${t.ref}`)
    wrong.push('the user is not crm_migrator.<ACCEPTANCE_PROJECT_REF>');
  if (t.host !== target.admin.host) wrong.push('the host differs from ACCEPTANCE_PGHOST');
  if (t.port !== '5432') wrong.push('the port is not 5432 (session pooler)');
  if (t.database !== 'postgres') wrong.push('the database is not postgres');
  if (!t.password || t.password !== target.passwords.migrator)
    wrong.push('the password is not ACCEPTANCE_CRM_MIGRATOR_PASSWORD');
  if (!t.caPath) wrong.push('no CA file');
  if (wrong.length)
    throw new Error(`ACCEPTANCE_DATABASE_MIGRATOR_URL is not usable:\n  - ${wrong.join('\n  - ')}`);
  return t;
}

/** Prisma schema-engine URL with strict TLS (chain and host name verified against the CA). */
export function prismaUrl(t) {
  if (!t.caPath) throw new Error('refusing to build a Prisma URL without a CA file');
  const host = t.prismaHost ?? t.host;
  const port = t.prismaPort ?? t.port;
  const q = new URLSearchParams({
    sslmode: 'require',
    sslcert: t.caPath.replace(/\\/g, '/'),
    sslaccept: 'strict',
  });
  return `postgresql://${encodeURIComponent(t.user)}:${encodeURIComponent(t.password)}@${host}:${port}/${t.database}?${q}`;
}

/** Prisma's environment, from scratch: nothing from .env or the caller's database variables. */
export function prismaEnv(t, { migrationsDir } = {}) {
  const keep = [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'ComSpec',
    'PATHEXT',
  ];
  const env = Object.fromEntries(
    keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
  );
  env.CRM_SUPABASE_MIGRATOR_URL = prismaUrl(t);
  env.PRISMA_HIDE_UPDATE_MESSAGE = '1';
  env.CHECKPOINT_DISABLE = '1';
  if (migrationsDir) env.CRM_SUPABASE_MIGRATIONS_DIR = migrationsDir;
  return env;
}

function redactor(t) {
  const secrets = [
    [t.password, '<redacted>'],
    [encodeURIComponent(t.password), '<redacted>'],
    [t.user, '<migrator>'],
    [t.host, '<host>'],
    [t.prismaHost, '<host>'],
    [t.ref, '<ref>'],
  ].filter(([s]) => s && s.length >= 3);
  return (s) =>
    secrets
      .reduce((out, [x, m]) => out.split(x).join(m), String(s ?? ''))
      .replace(/postgres(ql)?:\/\/\S+/g, '<url>');
}

function psql(t, input, timeout = 300000) {
  const pt = {
    admin: {
      host: t.psqlHost ?? t.host,
      port: t.psqlPort ?? t.port,
      database: t.database,
      user: t.user,
      password: t.password,
      caPath: t.caPath,
      sslmode: 'verify-full',
    },
  };
  const { command, args, env } = dockerPsql(
    pt,
    ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    process.env,
    {
      network: t.network,
    },
  );
  const r = spawnSync(command, args, { input, env, encoding: 'utf8', timeout, windowsHide: true });
  return {
    status: r.error ? -1 : r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  };
}

// ---------------------------------------------------------------------------------------------
// History

const STATUS_SQL = `\\set ON_ERROR_STOP on
\\pset format unaligned
\\pset tuples_only on
\\pset fieldsep '|'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
\\conninfo
SELECT 'who', current_user, current_database(), current_setting('transaction_read_only'),
       coalesce((SELECT ssl::text FROM pg_stat_ssl WHERE pid = pg_backend_pid()), 'unknown');
SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS has_ledger,
       to_regclass('${MARKER_TABLE}') IS NOT NULL AS has_marker \\gset
\\if :has_ledger
SELECT 'ledger', migration_name, checksum, finished_at IS NOT NULL, rolled_back_at IS NOT NULL
  FROM public._prisma_migrations ORDER BY started_at, migration_name;
\\endif
\\if :has_marker
SELECT 'marker', migration_name, checksum FROM ${MARKER_TABLE} ORDER BY migration_name;
\\endif
ROLLBACK;
`;

/** Compares the database's ledger and markers with the manifest. Pure. */
export function analyse(rows, manifest = MANIFEST) {
  const names = manifest.map(([n]) => n);
  const sums = Object.fromEntries(manifest);
  const problems = [];
  const ledger = rows
    .filter((r) => r[0] === 'ledger')
    .map(([, name, checksum, finished, rolledBack]) => ({
      name,
      checksum,
      finished: finished === 't',
      rolledBack: rolledBack === 't',
    }));
  const markers = rows
    .filter((r) => r[0] === 'marker')
    .map(([, name, checksum]) => ({ name, checksum }));
  for (const l of ledger) {
    if (!sums[l.name]) problems.push(`ledger: unknown migration ${l.name}`);
    else if (l.checksum !== sums[l.name])
      problems.push(`ledger: ${l.name} recorded with a different checksum`);
    if (!l.finished && !l.rolledBack)
      problems.push(
        `ledger: ${l.name} is recorded as started but not finished (a failed migration)`,
      );
    if (l.rolledBack) problems.push(`ledger: ${l.name} has a rolled-back entry`);
  }
  for (const m of markers) {
    if (!sums[m.name]) problems.push(`marker: unknown migration ${m.name}`);
    else if (m.checksum !== sums[m.name])
      problems.push(`marker: ${m.name} committed with a different checksum`);
  }
  const applied = [];
  const pending = [];
  const gaps = [];
  for (const name of names) {
    const L = ledger.some((l) => l.name === name && l.finished && !l.rolledBack);
    const M = markers.some((m) => m.name === name);
    if (L && M) applied.push(name);
    else if (!L && !M) pending.push(name);
    else if (M) {
      gaps.push(name);
      problems.push(
        `${name}: its SQL COMMITTED but Prisma has no record of it (crash gap); it will not be re-run`,
      );
    } else
      problems.push(`${name}: recorded by Prisma but not applied by this wrapper (another tool?)`);
  }
  const prefix = names.slice(0, applied.length);
  if (JSON.stringify(applied) !== JSON.stringify(prefix))
    problems.push('applied migrations are not a prefix of the reviewed order');
  return { applied, pending, gaps, problems, ledgerRows: ledger.length };
}

function readHistory(t, manifest) {
  const r = psql(t, STATUS_SQL, 120000);
  if (r.status !== 0) return { error: r };
  const rows = r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('|'));
  const who = rows.find((x) => x[0] === 'who');
  // TLS as the CLIENT sees it (psql's \conninfo; its host line is never printed). Through
  // Supabase's pooler, pg_stat_ssl (who[4]) describes the pooler->Postgres hop instead.
  const clientTls = /SSL connection \(protocol: (TLSv[0-9.]+)/.exec(r.stdout)?.[1] ?? null;
  return { who, clientTls, ...analyse(rows, manifest) };
}

function connectionError(r, clean) {
  if (r.status === CA_GUARD_EXIT) return 'the CA file was not mounted read-only; not connected';
  if (r.status === -1) return `could not run docker (${r.error?.code ?? 'error'})`;
  const msg = clean(r.stderr).trim().split(/\r?\n/).slice(-3).join(' | ');
  return `psql exited with ${r.status}${r.status === 2 ? ' (connection or certificate verification failed)' : ''}: ${msg || 'no message'}`;
}

// ---------------------------------------------------------------------------------------------
// Commands

const DEFAULT_LOG = (s) => console.log(s);

export function runStatus(
  t,
  { manifest = MANIFEST, migrationsDir = MIGRATIONS_DIR, log = DEFAULT_LOG } = {},
) {
  const clean = redactor(t);
  const local = loadMigrations(migrationsDir, manifest);
  log(
    `target      crm_migrator on project ${maskRef(t.ref)} via the session pooler, database ${t.database}`,
  );
  log(
    'TLS         psql: sslmode=verify-full, CA mounted read-only; Prisma: sslmode=require + sslcert + sslaccept=strict',
  );
  for (const p of local.problems) log(`  FAIL  local: ${p}`);
  const h = readHistory(t, manifest);
  if (h.error) {
    log(`  FAIL  ${connectionError(h.error, clean)}`);
    return { ok: false, connected: false };
  }
  log(
    `session     user=${h.who?.[1] === 'crm_migrator' ? 'crm_migrator' : 'UNEXPECTED'} database=${h.who?.[2]} read_only=${h.who?.[3]} client_tls=${h.clientTls ?? 'NONE'} (verify-full) server_side_ssl=${h.who?.[4]} (pooler hop; informational)`,
  );
  const problems = [...h.problems];
  if (h.who?.[1] !== 'crm_migrator') problems.push('not connected as crm_migrator');
  if (h.who?.[3] !== 'on') problems.push('the status session is not read-only');
  if (!h.clientTls) problems.push('psql does not report a TLS connection');
  const prismaProblem = prismaTlsProbe(t, { migrationsDir }, clean);
  log(
    `prisma      ${prismaProblem ? 'NOT connected' : 'connected with strict TLS (read-only status)'}`,
  );
  if (prismaProblem) problems.push(prismaProblem);
  log(`applied     ${h.applied.join(', ') || 'none'}`);
  log(`pending     ${h.pending.join(', ') || 'none'}`);
  for (const p of problems) log(`  STOP  ${p}`);
  const ok = problems.length === 0 && local.problems.length === 0;
  log(ok ? 'result: consistent' : 'result: NOT consistent; stop for review');
  return { ok, connected: true, ...h, problems: [...local.problems, ...problems] };
}

function acquireLock(path, log) {
  try {
    const fd = openSync(path, 'wx');
    writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    closeSync(fd);
    return () => {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    };
  } catch (e) {
    if (e.code === 'EEXIST')
      log(
        `  STOP  another migrate-supabase run holds the lock (${path}); if none is running, check the database with --status before removing it`,
      );
    else log(`  STOP  could not create the lock file (${e.code})`);
    return null;
  }
}

function applySql(m, previous) {
  const expected = previous.length
    ? `ARRAY[${previous.map((p) => `'${p.name}:${p.checksum}'`).join(', ')}]::text[]`
    : `'{}'::text[]`;
  return [
    '\\set ON_ERROR_STOP on',
    'BEGIN;',
    `SELECT pg_advisory_xact_lock(${ADVISORY_KEY});`,
    "SET LOCAL lock_timeout = '30s';",
    'SET LOCAL search_path = public;',
    `DO $crm_marker$
BEGIN
  IF to_regclass('${MARKER_TABLE}') IS NULL THEN
    CREATE TABLE ${MARKER_TABLE} (
      migration_name text PRIMARY KEY,
      checksum text NOT NULL,
      committed_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE ${MARKER_TABLE} IS 'CRM: migrations whose SQL committed (scripts/db/migrate-supabase.mjs)';
    REVOKE ALL ON ${MARKER_TABLE} FROM PUBLIC;
    ALTER TABLE ${MARKER_TABLE} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${MARKER_TABLE} FORCE ROW LEVEL SECURITY;
    CREATE POLICY maintenance ON ${MARKER_TABLE} FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
  END IF;
END $crm_marker$;`,
    `DO $crm_check$
DECLARE
  expected text[] := ${expected};
  ledger text[] := '{}';
  markers text[];
  bad bigint;
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL' INTO bad;
    IF bad > 0 THEN
      RAISE EXCEPTION 'crm-migrate: the Prisma ledger has failed or rolled-back entries; stop for review';
    END IF;
    EXECUTE 'SELECT coalesce(array_agg(migration_name || '':'' || checksum ORDER BY migration_name), ''{}'') FROM public._prisma_migrations' INTO ledger;
  END IF;
  EXECUTE 'SELECT coalesce(array_agg(migration_name || '':'' || checksum ORDER BY migration_name), ''{}'') FROM ${MARKER_TABLE}' INTO markers;
  IF ledger IS DISTINCT FROM expected OR markers IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'crm-migrate: history before ${m.name} is not exactly the reviewed migrations before it; stop for review';
  END IF;
END $crm_check$;`,
    `-- ${m.name}/migration.sql (unchanged, SHA-256 ${m.checksum})`,
    m.sql,
    '',
    `INSERT INTO ${MARKER_TABLE} (migration_name, checksum) VALUES ('${m.name}', '${m.checksum}');`,
    'COMMIT;',
    '',
  ].join('\n');
}

const prismaResolve = (t, name, opts) =>
  runPrisma(t, ['migrate', 'resolve', '--applied', name], opts);

/**
 * Proves Prisma can connect with strict TLS BEFORE anything is committed (otherwise the first
 * failure would be a crash gap after 0001). `prisma migrate status` only reads: verified offline
 * with log_statement=all (SELECTs only, nothing created).
 */
function prismaTlsProbe(t, opts, clean) {
  const r = runPrisma(t, ['migrate', 'status'], opts);
  const connected =
    !/Error: P1\d{3}/.test(r.out) &&
    /not yet been applied|Database schema is up to date/.test(r.out);
  if (connected) return null;
  const why = clean(r.out).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ');
  return `Prisma could not connect with strict TLS (nothing was changed): ${why || `exit ${r.status}`}`;
}

function runPrisma(t, args, { migrationsDir, prismaConfig = PRISMA_CONFIG } = {}) {
  const r = spawnSync(process.execPath, [PRISMA_CLI, ...args, '--config', prismaConfig], {
    cwd: REPO,
    env: prismaEnv(t, {
      migrationsDir: migrationsDir === MIGRATIONS_DIR ? undefined : migrationsDir,
    }),
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  });
  return { status: r.error ? -1 : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function recordAndVerify(t, m, opts, clean, log) {
  const pr = prismaResolve(t, m.name, opts);
  if (pr.status !== 0) {
    log(
      `  STOP  ${m.name}: SQL COMMITTED, but recording it with Prisma failed: ${clean(pr.out).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}`,
    );
    log(
      `        Not re-running it. Review with --status, then: node scripts/db/migrate-supabase.mjs --record-committed ${m.name}`,
    );
    return false;
  }
  const h = readHistory(t, opts.manifest);
  if (h.error) {
    log(
      `  STOP  ${m.name}: recorded, but the ledger could not be read back: ${connectionError(h.error, clean)}`,
    );
    return false;
  }
  if (!h.applied.includes(m.name) || h.problems.length) {
    log(
      `  STOP  ${m.name}: the ledger does not show it cleanly applied: ${h.problems.join('; ') || 'not listed'}`,
    );
    return false;
  }
  log(`  ok    ${m.name}: committed, recorded, ledger verified`);
  return true;
}

export function runDeploy(t, opts = {}) {
  const {
    manifest = MANIFEST,
    migrationsDir = MIGRATIONS_DIR,
    lockPath = LOCK_PATH,
    log = DEFAULT_LOG,
    hooks = {},
  } = opts;
  const o = { ...opts, manifest, migrationsDir };
  const clean = redactor(t);
  const local = loadMigrations(migrationsDir, manifest);
  if (local.problems.length) {
    for (const p of local.problems) log(`  STOP  local: ${p}`);
    return { ok: false, applied: [] };
  }
  const release = acquireLock(lockPath, log);
  if (!release) return { ok: false, locked: true, applied: [] };
  const applied = [];
  try {
    hooks.afterLock?.();
    const st = runStatus(t, { manifest, migrationsDir, log });
    if (!st.ok) return { ok: false, applied };
    if (!st.pending.length) {
      log('nothing to apply: every reviewed migration is applied and recorded');
      return { ok: true, applied };
    }
    for (const m of local.migrations) {
      if (!st.pending.includes(m.name)) continue;
      const previous = local.migrations.slice(0, local.migrations.indexOf(m));
      log(`  ...   ${m.name}: applying in one transaction`);
      const r = psql(t, applySql(m, previous));
      if (r.status !== 0) {
        log(
          `  STOP  ${m.name}: failed and ROLLED BACK (nothing from it remains; later migrations not run): ${connectionError(r, clean)}`,
        );
        return { ok: false, applied, failed: m.name };
      }
      hooks.afterCommit?.(m.name);
      if (!recordAndVerify(t, m, o, clean, log)) return { ok: false, applied, gap: m.name };
      applied.push(m.name);
    }
    log(`done: applied ${applied.join(', ')}`);
    return { ok: true, applied };
  } finally {
    release();
  }
}

export function runRecordCommitted(t, name, opts = {}) {
  const {
    manifest = MANIFEST,
    migrationsDir = MIGRATIONS_DIR,
    lockPath = LOCK_PATH,
    log = DEFAULT_LOG,
  } = opts;
  const o = { ...opts, manifest, migrationsDir };
  const clean = redactor(t);
  const local = loadMigrations(migrationsDir, manifest);
  const m = local.migrations.find((x) => x.name === name);
  if (local.problems.length || !m) {
    log(`  STOP  ${m ? local.problems.join('; ') : `${name} is not a reviewed migration`}`);
    return { ok: false };
  }
  const release = acquireLock(lockPath, log);
  if (!release) return { ok: false, locked: true };
  try {
    const st = runStatus(t, { manifest, migrationsDir, log });
    const others = (st.problems ?? []).filter((p) => !p.startsWith(`${name}: its SQL COMMITTED`));
    if (!st.connected || !st.gaps?.includes(name) || others.length || st.gaps.length !== 1) {
      log(`  STOP  ${name} is not the single committed-but-unrecorded migration; nothing recorded`);
      return { ok: false };
    }
    return { ok: recordAndVerify(t, m, o, clean, log) };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------------------------
// Post-migration verification (read-only)

export const VERIFY_SQL_PATH = join(REPO, 'scripts', 'db', 'verify-supabase.sql');
export const VERIFY_CHECKS = 14;

/**
 * Anything in the verification SQL that could change database state. The only psql meta-command
 * allowed is `\set ON_ERROR_STOP on`; every statement must be a plain SELECT/WITH with no
 * writing statement, SELECT INTO or state-changing function. Literals and comments are ignored.
 */
export function verifySqlProblems(sql) {
  const s = sqlStructure(sql);
  if (s === null) return ['unterminated quote, dollar quote or comment'];
  const problems = [];
  const lines = s.split(/\r?\n/);
  for (const line of lines.filter((l) => l.includes('\\')))
    if (line.trim() !== '\\set ON_ERROR_STOP on')
      problems.push(`psql meta-command: ${line.trim().slice(0, 40)}`);
  const code = lines.filter((l) => !l.includes('\\')).join('\n');
  if (/\$\$/.test(code)) problems.push('a dollar-quoted body (DO block or function)');
  const words =
    /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|COPY|CALL|DO|SET|RESET|COMMIT|ROLLBACK|BEGIN|START|SAVEPOINT|LOCK|VACUUM|ANALYZE|CLUSTER|REINDEX|REFRESH|NOTIFY|LISTEN|PREPARE|EXECUTE|DISCARD|COMMENT|SECURITY|IMPORT|INTO|CHECKPOINT|LOAD)\b/gi;
  for (const m of new Set([...code.matchAll(words)].map((x) => x[1].toUpperCase())))
    problems.push(`keyword ${m}`);
  const fns =
    /\b(nextval|setval|set_config|pg_advisory\w*|pg_try_advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|lo_\w+|dblink\w*|pg_file_write|pg_notify|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_replication\w*|txid_current|pg_current_xact_id)\s*\(/gi;
  for (const m of new Set([...code.matchAll(fns)].map((x) => x[1].toLowerCase())))
    problems.push(`state-changing function ${m}()`);
  for (const st of code
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean))
    if (!/^(SELECT|WITH)\b/i.test(st))
      problems.push(`statement is not SELECT/WITH: ${st.slice(0, 30)}`);
  return problems;
}

/** schema.table for every CREATE TABLE in the migrations (outside function bodies and comments). */
export function expectedAppTables(migrations) {
  const names = new Set();
  for (const m of migrations) {
    const code = m.sql
      .replace(/\$([A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$\1\$/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ');
    for (const x of code.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([A-Za-z_]\w*)"?\.)?"?([A-Za-z_]\w*)"?\s*\(/gi,
    ))
      names.add(`${(x[1] ?? 'public').toLowerCase()}.${x[2].toLowerCase()}`);
  }
  return [...names].sort();
}

/**
 * Pure: psql output of the verification -> result. Every check 1..VERIFY_CHECKS must appear
 * exactly once with ok = t; the CRM tables must be exactly the migrations' tables plus the marker.
 */
export function evaluateVerify(stdout, expectedTables) {
  const rows = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('|'));
  const checks = rows.filter((r) => /^\d+$/.test(r[0]));
  const problems = [];
  const lines = [];
  for (let n = 1; n <= VERIFY_CHECKS; n++) {
    const found = checks.filter((r) => Number(r[0]) === n);
    if (found.length !== 1) {
      problems.push(
        `check ${n}: ${found.length ? 'reported more than once' : 'MISSING (not run)'}`,
      );
      lines.push(`  FAIL  ${n} missing`);
      continue;
    }
    const [, item, ok, ...detail] = found[0];
    const pass = ok === 't';
    if (!pass) problems.push(`check ${n} failed: ${item} (${detail.join('|')})`);
    lines.push(`  ${pass ? 'ok  ' : 'FAIL'}  ${n} ${item}: ${detail.join('|')}`);
  }
  for (const r of checks)
    if (Number(r[0]) > VERIFY_CHECKS || Number(r[0]) < 1) problems.push(`unexpected check ${r[0]}`);
  const actual = rows
    .filter((r) => r[0] === 'table')
    .map(([, schema, name]) => `${schema}.${name}`)
    .filter((x) => x !== 'public._prisma_migrations')
    .sort();
  const expected = [...expectedTables, 'public._crm_migration_marker'].sort();
  const missing = expected.filter((x) => !actual.includes(x));
  const extra = actual.filter((x) => !expected.includes(x));
  lines.push(
    `  ${missing.length || extra.length ? 'FAIL' : 'ok  '}  tables: ${actual.length} found = ${expectedTables.length} application tables from the migrations + _crm_migration_marker expected (${expected.length})`,
  );
  if (missing.length) problems.push(`tables missing: ${missing.join(', ')}`);
  if (extra.length) problems.push(`unexpected tables owned by crm_migrator: ${extra.join(', ')}`);
  return { ok: problems.length === 0, problems, lines, tableCount: actual.length };
}

export function runVerify(t, opts = {}) {
  const {
    manifest = MANIFEST,
    migrationsDir = MIGRATIONS_DIR,
    log = DEFAULT_LOG,
    verifySqlPath = VERIFY_SQL_PATH,
  } = opts;
  const clean = redactor(t);
  const local = loadMigrations(migrationsDir, manifest);
  const sql = readFileSync(verifySqlPath, 'utf8');
  const unsafe = verifySqlProblems(sql);
  if (local.problems.length || unsafe.length) {
    for (const p of local.problems) log(`  STOP  local: ${p}`);
    for (const p of unsafe) log(`  STOP  verify-supabase.sql could change state, not run: ${p}`);
    return { ok: false, connected: false };
  }
  const expectedTables = expectedAppTables(local.migrations);
  const st = runStatus(t, { manifest, migrationsDir, log });
  if (!st.ok || st.pending?.length || st.applied?.length !== manifest.length) {
    log('  STOP  verification needs every reviewed migration applied and a consistent history');
    return { ok: false, connected: !!st.connected };
  }
  const input = [
    '\\set ON_ERROR_STOP on',
    '\\pset format unaligned',
    '\\pset tuples_only on',
    "\\pset fieldsep '|'",
    'BEGIN TRANSACTION READ ONLY;',
    "SET LOCAL statement_timeout = '30s';",
    sql,
    `SELECT 'table', n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'app')
    AND pg_get_userbyid(c.relowner) = 'crm_migrator' ORDER BY 2, 3;`,
    'ROLLBACK;',
    '',
  ].join('\n');
  const r = psql(t, input, 120000);
  if (r.status !== 0) {
    log(
      `  FAIL  verification did not complete (a failure, not a pass): ${connectionError(r, clean)}`,
    );
    return { ok: false, connected: true };
  }
  const v = evaluateVerify(r.stdout, expectedTables);
  for (const l of v.lines) log(l);
  for (const p of v.problems) log(`  STOP  ${p}`);
  log(
    v.ok
      ? 'result: verified (read-only; nothing changed)'
      : 'result: verification FAILED; stop for review',
  );
  return { ...v, connected: true };
}

// ---------------------------------------------------------------------------------------------
// CLI

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const usage =
    'usage: [--target qa|prod] --status | --verify | --deploy | --record-committed <migration>';
  let t;
  let envTarget;
  let mode;
  let arg;
  try {
    const parsed = takeTarget(process.argv.slice(2));
    envTarget = parsed.target;
    let rest;
    [mode, arg, ...rest] = parsed.rest;
    if (
      !['--status', '--verify', '--deploy', '--record-committed'].includes(mode) ||
      rest.length ||
      (mode === '--record-committed') !== !!arg
    )
      throw new Error(usage);
    t = migratorTarget(loadTargetEnv(envTarget));
  } catch (e) {
    console.error(`migrate-supabase: ${e.message}`);
    process.exit(1);
  }
  console.log(
    `migrate-supabase: target ${envTarget ?? 'acceptance (.env)'}, project ${maskRef(t.ref)}`,
  );
  if (
    envTarget === 'prod' &&
    (mode === '--deploy' || mode === '--record-committed') &&
    !(await confirmProduction(
      t.ref,
      mode === '--deploy' ? 'apply pending migrations' : `record ${arg} as applied`,
    ))
  ) {
    console.error('migrate-supabase: not confirmed; nothing was changed');
    process.exit(1);
  }
  const r =
    mode === '--status'
      ? runStatus(t)
      : mode === '--verify'
        ? runVerify(t)
        : mode === '--deploy'
          ? runDeploy(t)
          : runRecordCommitted(t, arg);
  process.exit(r.ok ? 0 : 1);
}
