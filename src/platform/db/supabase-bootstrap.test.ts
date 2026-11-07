// Static checks of the split Supabase bootstrap (runbook §4): step A (roles and grants) and
// step B (extensions and uuidv7) stay separate, and step A switches statement logging and
// pg_stat_statements off for its own transaction before any verifier reaches the server. They
// run without a database; the PostgreSQL 17 rehearsal is recorded in the runbook (§9).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');
/** Comments removed, whitespace collapsed. */
const normalise = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const roles = normalise(read('scripts', 'db', 'bootstrap-supabase.sql'));
const extensions = normalise(read('scripts', 'db', 'bootstrap-supabase-extensions.sql'));
const wrapperSource = read('scripts', 'db', 'bootstrap-supabase.mjs');

type Wrapper = {
  rolesScript: (passwords: Record<string, string>, opts?: { quietDdl?: boolean }) => string;
  extensionsScript: () => string;
};
const loadWrapper = async () =>
  (await import(
    pathToFileURL(join(root, 'scripts', 'db', 'bootstrap-supabase.mjs')).href
  )) as Wrapper;
const synthetic = Object.fromEntries(
  ['migrator', 'app', 'auth', 'platform', 'cleanup'].map((r) => [
    r,
    `synthetic-${r}-0123456789abcdef`,
  ]),
);

describe('step A: roles and grants only', () => {
  it('creates the six roles with no elevated attribute', () => {
    for (const r of ['crm_migrator', 'crm_app', 'crm_auth', 'crm_platform'])
      expect(roles).toMatch(
        new RegExp(
          `CREATE ROLE ${r} LOGIN PASSWORD :'\\w+_verifier' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;`,
        ),
      );
    expect(roles).toContain(
      'CREATE ROLE crm_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;',
    );
    expect(roles).not.toMatch(/\b(SUPERUSER|BYPASSRLS|CREATEROLE|CREATEDB|REPLICATION)\b/);
  });

  it('creates no extension, function, schema or table and applies no migration', () => {
    expect(roles).not.toMatch(
      /CREATE (EXTENSION|(OR REPLACE )?FUNCTION|SCHEMA|TABLE)|uuidv7|_prisma_migrations|ALTER (SYSTEM|DATABASE)/i,
    );
  });

  it('switches logging off for its own transaction before any verifier is sent', () => {
    const firstVerifierUse = roles.indexOf(":'migrator_verifier'");
    for (const set of [
      "SET LOCAL log_statement = 'none';",
      'SET LOCAL log_min_duration_statement = -1;',
      "SET LOCAL log_min_error_statement = 'panic';",
      "SET LOCAL pgaudit.log = 'none';",
      'SET LOCAL pg_stat_statements.track_utility = off;',
    ]) {
      expect(roles, set).toContain(set);
      expect(roles.indexOf(set), set).toBeLessThan(firstVerifierUse);
    }
    expect(roles.indexOf('AS quiet_ok \\gset')).toBeLessThan(firstVerifierUse);
    expect(roles).toMatch(
      /\\if :quiet_ok \\else DO \$\$ BEGIN RAISE EXCEPTION 'statement logging could not be switched off/,
    );
    // Only transaction-local: never a persistent or server-wide change.
    expect(roles).not.toMatch(
      /ALTER (ROLE|DATABASE|SYSTEM) [^;]*(log_|pgaudit|pg_stat_statements)/i,
    );
    // Every SET is SET LOCAL (ALTER ROLE ... SET <timeout> is a role default, not logging).
    expect(roles.match(/(?<!ROLE \w+ )\bSET (?!LOCAL)[a-z_.]+ (=|TO)/g) ?? []).toEqual([]);
  });

  it('refuses to run without the quiet_ddl decision, and keeps passwords on a rerun', () => {
    expect(roles).toMatch(
      /\\if :\{\?quiet_ddl\} \\else DO \$\$ BEGIN RAISE EXCEPTION 'quiet_ddl not set/,
    );
    expect(roles).toMatch(/\\if :create_roles CREATE ROLE crm_migrator/);
    expect(roles).toMatch(/\\if :cleanup_present \\unset cleanup_verifier \\endif/);
  });
});

describe('step B: extensions and uuidv7 only', () => {
  it('creates no role, sends no verifier and changes no role', () => {
    expect(extensions).not.toMatch(/(CREATE|ALTER|DROP) ROLE|PASSWORD|verifier|SCRAM|GRANT crm_/i);
    expect(extensions).toMatch(/AS roles_ok FROM pg_roles/);
    expect(extensions).toContain("RAISE EXCEPTION 'the CRM roles are missing");
  });

  it('installs the three extensions in public and a locked-down uuidv7', () => {
    for (const e of ['citext', 'btree_gist', 'pg_trgm'])
      expect(extensions).toContain(`CREATE EXTENSION IF NOT EXISTS ${e} WITH SCHEMA public;`);
    expect(extensions).toContain('REVOKE ALL ON FUNCTION public.uuidv7() FROM PUBLIC;');
    expect(extensions).toContain(
      'GRANT EXECUTE ON FUNCTION public.uuidv7() TO crm_migrator, crm_app, crm_auth, crm_platform, crm_definer;',
    );
    expect(extensions).toContain("ARRAY['anon', 'authenticated', 'service_role']");
  });

  it('never replaces a public.uuidv7() it did not create', () => {
    expect(extensions).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
    expect(extensions).toContain('CREATE FUNCTION public.uuidv7() RETURNS uuid');
    expect(extensions).toMatch(
      /\\if :uuidv7_present \\if :uuidv7_ours .* \\else DO \$\$ BEGIN RAISE EXCEPTION 'public\.uuidv7\(\) already exists and was not created by this script/,
    );
    expect(extensions).toContain("AND d.deptype = 'e'"); // an extension's function is never "ours"
  });
});

describe('wrapper', () => {
  it('step A script: verifiers only as client-side psql variables, quiet_ddl on by default, one transaction', async () => {
    const { rolesScript } = await loadWrapper();
    const sql = rolesScript(synthetic);
    for (const pw of Object.values(synthetic)) expect(sql).not.toContain(pw);
    const verifierLines = sql.split('\n').filter((l) => l.includes('SCRAM-SHA-256$'));
    expect(verifierLines).toHaveLength(5);
    for (const l of verifierLines) expect(l).toMatch(/^\\set \w+_verifier 'SCRAM-SHA-256\$4096:/);
    expect(sql).toMatch(/^\\set ON_ERROR_STOP on$/m);
    expect(sql).toMatch(/^\\set quiet_ddl true$/m);
    expect(sql.indexOf('BEGIN;')).toBeLessThan(sql.indexOf("SET LOCAL log_statement = 'none';"));
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).not.toMatch(/CREATE EXTENSION|uuidv7\(\) RETURNS/);
    expect(rolesScript(synthetic, { quietDdl: false })).toMatch(/^\\set quiet_ddl false$/m);
  });

  it('step B script: no verifier, no role, one transaction', async () => {
    const { extensionsScript } = await loadWrapper();
    const sql = extensionsScript();
    expect(normalise(sql)).not.toMatch(/verifier|SCRAM|CREATE ROLE|ALTER ROLE|PASSWORD/);
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('--run always uses the guard; only the local --emit-sql may drop it', () => {
    expect(wrapperSource).toContain(
      "run('step A (roles and grants)', (t) => rolesScript(t.passwords));",
    );
    expect(wrapperSource).toContain(
      "run('step B (extensions and uuidv7)', () => extensionsScript());",
    );
    expect(wrapperSource).toContain("(allowLogging && mode !== '--emit-sql')");
    expect(wrapperSource).toContain('input: input(t)'); // stdin, never argv
  });
});
