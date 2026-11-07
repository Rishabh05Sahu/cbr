// Offline checks of scripts/db/migrate-supabase.mjs (no database, no network): target selection
// (ACCEPTANCE_DATABASE_MIGRATOR_URL only), strict TLS for Prisma, the static migration checks and
// the history analysis that detects a committed-but-unrecorded migration. The end-to-end runs on
// throwaway PostgreSQL 17 containers are recorded in the runbook (§6).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const CA = join(__dirname, '__fixtures__', 'test-only-ca.crt');
const REF = 'abcdefghij0123456789';
const HOST = 'aws-0-eu-west-1.pooler.supabase.com'; // synthetic: never connected to
const PW = {
  migrator: 'Mig-synthetic-0123456789abcdefXYZ',
  app: 'App-synthetic-0123456789abcdefXYZ',
  auth: 'Auth-synthetic-0123456789abcdefXY',
  platform: 'Plat-synthetic-0123456789abcdefXY',
  cleanup: 'Clean-synthetic-0123456789abcdefX',
};
const URL_VAR: Record<string, string> = {
  migrator: 'ACCEPTANCE_DATABASE_MIGRATOR_URL',
  app: 'ACCEPTANCE_DATABASE_URL',
  auth: 'ACCEPTANCE_AUTH_DATABASE_URL',
  platform: 'ACCEPTANCE_PLATFORM_DATABASE_URL',
  cleanup: 'ACCEPTANCE_CLEANUP_DATABASE_URL',
};
function env(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {
    // The local development settings the wrapper must never use.
    DATABASE_MIGRATOR_URL: 'postgresql://crm_migrator:local-migrator-pw@127.0.0.1:55432/crm_dev',
    DATABASE_URL: 'postgresql://crm_app:local-app-pw@127.0.0.1:55432/crm_dev',
    ACCEPTANCE_PROJECT_REF: REF,
    ACCEPTANCE_PGHOST: HOST,
    ACCEPTANCE_PGPORT: '5432',
    ACCEPTANCE_PGDATABASE: 'postgres',
    ACCEPTANCE_PGUSER: `postgres.${REF}`,
    ACCEPTANCE_PGPASSWORD: 'Admin-synthetic-0123456789abcdefX',
    ACCEPTANCE_PGSSLMODE: 'verify-full',
    ACCEPTANCE_PGSSLROOTCERT: CA,
  };
  for (const [r, pw] of Object.entries(PW)) {
    e[`ACCEPTANCE_CRM_${r.toUpperCase()}_PASSWORD`] = pw;
    e[URL_VAR[r]!] = `postgresql://crm_${r}.${REF}:${pw}@${HOST}:5432/postgres`;
  }
  return { ...e, ...extra };
}

type Target = {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  caPath: string;
};
type Mod = {
  migratorTarget: (e: Record<string, string>) => Target;
  prismaUrl: (t: Target) => string;
  prismaEnv: (t: Target) => Record<string, string>;
  migrationProblems: (sql: string) => string[];
  loadMigrations: () => { migrations: unknown[]; problems: string[] };
  analyse: (rows: string[][]) => {
    applied: string[];
    pending: string[];
    gaps: string[];
    problems: string[];
  };
  MANIFEST: [string, string][];
  verifySqlProblems: (sql: string) => string[];
  expectedAppTables: (migrations: unknown[]) => string[];
  evaluateVerify: (
    stdout: string,
    expected: string[],
  ) => { ok: boolean; problems: string[]; tableCount: number };
  VERIFY_SQL_PATH: string;
  VERIFY_CHECKS: number;
};
let mod: Mod;
beforeAll(async () => {
  mod = (await import(
    pathToFileURL(join(root, 'scripts', 'db', 'migrate-supabase.mjs')).href
  )) as Mod;
});

describe('target selection', () => {
  it('uses ACCEPTANCE_DATABASE_MIGRATOR_URL, never the local DATABASE_MIGRATOR_URL', () => {
    const t = mod.migratorTarget(env());
    expect(t).toMatchObject({
      host: HOST,
      port: '5432',
      database: 'postgres',
      user: `crm_migrator.${REF}`,
    });
    expect(t.password).toBe(PW.migrator);
    expect(JSON.stringify(t)).not.toMatch(/127\.0\.0\.1|crm_dev|local-migrator-pw/);
  });

  it('refuses when the acceptance URL is missing, even with a local DATABASE_MIGRATOR_URL', () => {
    expect(() => mod.migratorTarget(env({ ACCEPTANCE_DATABASE_MIGRATOR_URL: '' }))).toThrow(
      /ACCEPTANCE_DATABASE_MIGRATOR_URL/,
    );
  });

  it('refuses a local or non-pooler host, a wrong user and a weaker sslmode', () => {
    const local = `postgresql://crm_migrator.${REF}:${PW.migrator}@127.0.0.1:5432/postgres`;
    expect(() => mod.migratorTarget(env({ ACCEPTANCE_DATABASE_MIGRATOR_URL: local }))).toThrow();
    const app = `postgresql://crm_app.${REF}:${PW.migrator}@${HOST}:5432/postgres`;
    expect(() => mod.migratorTarget(env({ ACCEPTANCE_DATABASE_MIGRATOR_URL: app }))).toThrow();
    const weak = `postgresql://crm_migrator.${REF}:${PW.migrator}@${HOST}:5432/postgres?sslmode=require`;
    expect(() => mod.migratorTarget(env({ ACCEPTANCE_DATABASE_MIGRATOR_URL: weak }))).toThrow();
  });

  it('refuses without a usable CA file, and never puts a password in its errors', () => {
    let message = '';
    try {
      mod.migratorTarget(env({ ACCEPTANCE_PGSSLROOTCERT: join(__dirname, 'no-such-ca.crt') }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ACCEPTANCE_PGSSLROOTCERT/);
    for (const pw of Object.values(PW)) expect(message).not.toContain(pw);
  });
});

describe('Prisma connection', () => {
  it('strict TLS: sslmode=require + sslcert + sslaccept=strict, never verify-full alone', () => {
    const u = new URL(mod.prismaUrl(mod.migratorTarget(env())));
    expect(u.searchParams.get('sslmode')).toBe('require');
    expect(u.searchParams.get('sslaccept')).toBe('strict');
    expect(u.searchParams.get('sslcert')).toBe(CA.replace(/\\/g, '/'));
    expect([...u.searchParams.keys()].sort()).toEqual(['sslaccept', 'sslcert', 'sslmode']);
    expect(u.hostname).toBe(HOST);
  });

  it('runs with an environment built from scratch and a config that does not load .env', () => {
    const e = mod.prismaEnv(mod.migratorTarget(env()));
    expect(
      Object.keys(e).filter((k) => /DATABASE|ACCEPTANCE|SUPABASE_URL|PG[A-Z]/.test(k)),
    ).toEqual([]);
    expect(e.CRM_SUPABASE_MIGRATOR_URL).toMatch(/sslaccept=strict/);
    const config = readFileSync(
      join(root, 'scripts', 'db', 'prisma.supabase.config.mjs'),
      'utf8',
    ).replace(/\/\/[^\n]*/g, ''); // code only
    expect(config).not.toMatch(/dotenv|readFileSync|[^_]DATABASE_MIGRATOR_URL/);
    expect(config).toContain('process.env.CRM_SUPABASE_MIGRATOR_URL');
  });
});

describe('static migration checks', () => {
  it('the eight reviewed migrations are present, unchanged and transaction-safe', () => {
    const r = mod.loadMigrations();
    // Newer local migrations (0009+, not yet reviewed for Supabase) are reported, never deployed.
    const unreviewed = r.problems.filter((p) => p.startsWith('unreviewed migration directories'));
    expect(r.problems.filter((p) => !unreviewed.includes(p))).toEqual([]);
    expect(unreviewed.join()).not.toMatch(/000[1-8]_/);
    expect(r.migrations).toHaveLength(8);
    expect(mod.MANIFEST.map(([n]) => n)).toEqual([
      '0001_foundation',
      '0002_security',
      '0003_leads',
      '0004_assignment',
      '0005_imports',
      '0006_hygiene',
      '0007_lead_email_normalized',
      '0008_lead_name_sort_index',
    ]);
  });

  it.each([
    ['transaction control', 'SELECT 1;\nCOMMIT;\nSELECT 2;\n', /transaction control/],
    ['CONCURRENTLY', 'CREATE INDEX CONCURRENTLY i ON t (a);\n', /not allowed in a transaction/],
    ['psql meta-command', 'SELECT 1;\n\\! echo hi\n', /meta-command/],
    ['psql variable', 'SELECT :foo;\n', /psql variable/],
    ['ALTER SYSTEM', 'ALTER SYSTEM SET work_mem = 1;\n', /server-level/],
    ['missing semicolon', 'SELECT 1', /semicolon/],
    ['open quote', "SELECT 'x;\n", /unterminated/],
  ])('refuses %s', (_name, sql, problem) => {
    expect(mod.migrationProblems(sql).join(' ')).toMatch(problem);
  });

  it('accepts casts, dollar-quoted bodies, E-strings and doubled quotes', () => {
    const sql =
      'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;\n' +
      "SELECT 1::int, E'a\\'b;', 'it''s', $x$ COMMIT; :v $x$; -- COMMIT;\n/* BEGIN; */ SELECT 2;\n";
    expect(mod.migrationProblems(sql)).toEqual([]);
  });
});

describe('history analysis', () => {
  const [n1, s1] = [
    '0001_foundation',
    '75d334b081bebcee721769713ef42cdccab56e022b4a58e0f99b13db390020b7',
  ];
  const [n2, s2] = [
    '0002_security',
    '73a484865958997e60af3d278d32ed92270440e0fd0cc50bc088315b65d6fd76',
  ];
  const ledger = (n: string, s: string, finished = 't', rolledBack = 'f') => [
    'ledger',
    n,
    s,
    finished,
    rolledBack,
  ];
  const marker = (n: string, s: string) => ['marker', n, s];

  it('fresh database: all pending, no problems', () => {
    const a = mod.analyse([]);
    expect(a.pending).toHaveLength(8);
    expect(a.problems).toEqual([]);
  });

  it('applied = ledger and marker agree', () => {
    const a = mod.analyse([ledger(n1, s1), marker(n1, s1)]);
    expect(a.applied).toEqual([n1]);
    expect(a.problems).toEqual([]);
  });

  it('crash gap: SQL committed (marker) but no Prisma record, reported and never pending', () => {
    const a = mod.analyse([ledger(n1, s1), marker(n1, s1), marker(n2, s2)]);
    expect(a.gaps).toEqual([n2]);
    expect(a.pending).not.toContain(n2);
    expect(a.problems.join()).toMatch(/0002_security: its SQL COMMITTED but Prisma has no record/);
  });

  it('flags a Prisma record without a marker, a failed ledger entry and a changed checksum', () => {
    expect(mod.analyse([ledger(n1, s1)]).problems.join()).toMatch(/not applied by this wrapper/);
    expect(mod.analyse([ledger(n1, s1, 'f'), marker(n1, s1)]).problems.join()).toMatch(
      /started but not finished/,
    );
    expect(mod.analyse([ledger(n1, 'x'.repeat(64)), marker(n1, s1)]).problems.join()).toMatch(
      /different checksum/,
    );
  });
});

describe('post-migration verification (--verify)', () => {
  it('verify-supabase.sql is read-only by the static scan', () => {
    expect(mod.verifySqlProblems(readFileSync(mod.VERIFY_SQL_PATH, 'utf8'))).toEqual([]);
  });

  it.each([
    ['a DELETE', 'SELECT 1;\nDELETE FROM t;\n', /keyword DELETE/],
    ['CREATE TABLE', 'CREATE TABLE t (a int);\n', /keyword CREATE/],
    ['SELECT INTO', 'SELECT 1 INTO t;\n', /keyword INTO/],
    ['a DO block', 'DO $$ BEGIN PERFORM 1; END $$;\n', /dollar-quoted|keyword DO/],
    ['nextval()', 'SELECT nextval(1);\n', /state-changing function nextval/],
    ['set_config()', "SELECT set_config('a', 'b', false);\n", /set_config/],
    ['a psql include', 'SELECT 1;\n\\i other.sql\n', /psql meta-command/],
    ['SET', 'SET search_path = x;\nSELECT 1;\n', /keyword SET/],
  ])('refuses %s', (_name, sql, problem) => {
    expect(mod.verifySqlProblems(sql).join(' ')).toMatch(problem);
  });

  it('ignores keywords inside literals and comments', () => {
    expect(
      mod.verifySqlProblems("-- DELETE everything\nSELECT 'INSERT, UPDATE, DELETE' AS x;\n"),
    ).toEqual([]);
  });

  it('expects exactly the 27 tables the migrations create', () => {
    const tables = mod.expectedAppTables(mod.loadMigrations().migrations);
    expect(tables).toHaveLength(27);
    expect(tables).toContain('public.lead');
    expect(tables).toContain('public.import_job');
    expect(tables.every((t) => t.startsWith('public.'))).toBe(true);
  });

  const expected = ['public.a', 'public.b'];
  const tableRows = [
    'table|public|a',
    'table|public|b',
    'table|public|_crm_migration_marker',
    'table|public|_prisma_migrations',
  ];
  const checkRows = (override: Record<number, string> = {}) =>
    Array.from({ length: 14 }, (_, i) => override[i + 1] ?? `${i + 1}|check ${i + 1}|t|detail`);

  it('passes only with all 14 checks true and exactly the expected tables + marker', () => {
    const v = mod.evaluateVerify([...checkRows(), ...tableRows].join('\n'), expected);
    expect(v.ok).toBe(true);
    expect(v.tableCount).toBe(3);
  });

  it('a failed, missing or duplicated check is a failure', () => {
    expect(
      mod
        .evaluateVerify(
          [...checkRows({ 6: '6|api|f|anon on lead' }), ...tableRows].join('\n'),
          expected,
        )
        .problems.join(),
    ).toMatch(/check 6 failed/);
    const missing = checkRows().filter((r) => !r.startsWith('9|'));
    expect(
      mod.evaluateVerify([...missing, ...tableRows].join('\n'), expected).problems.join(),
    ).toMatch(/check 9: MISSING/);
    expect(
      mod.evaluateVerify([...checkRows(), '3|again|t|x', ...tableRows].join('\n'), expected).ok,
    ).toBe(false);
    expect(mod.evaluateVerify('', expected).ok).toBe(false);
  });

  it('a missing or unexpected table is a failure, the marker is required', () => {
    expect(
      mod
        .evaluateVerify([...checkRows(), ...tableRows, 'table|public|extra'].join('\n'), expected)
        .problems.join(),
    ).toMatch(/unexpected tables.*public\.extra/);
    const noMarker = tableRows.filter((r) => !r.includes('_crm_migration_marker'));
    expect(
      mod.evaluateVerify([...checkRows(), ...noMarker].join('\n'), expected).problems.join(),
    ).toMatch(/tables missing: public\._crm_migration_marker/);
  });
});
