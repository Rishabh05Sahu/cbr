// Static checks of the crm_cleanup boundary (Phase 2 M4) over the migration and provisioning
// SQL. They run without a database; tests/integration/import-cleanup-role.test.ts proves the
// same rules against PostgreSQL once 0005_imports is applied.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');
/** Comments removed, whitespace collapsed. */
const normalise = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const migrationsDir = join(root, 'prisma', 'migrations');
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => normalise(read('prisma', 'migrations', d.name, 'migration.sql')))
  .join(' ');
const m0005 = normalise(read('prisma', 'migrations', '0005_imports', 'migration.sql'));
const m0006 = normalise(read('prisma', 'migrations', '0006_hygiene', 'migration.sql'));
const provision = normalise(read('scripts', 'db', 'provision-cleanup-role.sql'));

/** Every grantee of every GRANT on app.import_files_due, across all migrations. */
function functionGrantees(sql: string): string[] {
  return [
    ...sql.matchAll(/GRANT [^;]*? ON FUNCTION [^;]*?app\.import_files_due[^;]*? TO ([^;]+);/gi),
  ]
    .flatMap((m) => m[1]!.split(','))
    .map((s) => s.trim());
}

describe('app.import_files_due', () => {
  const fn = /CREATE FUNCTION app\.import_files_due\([^)]*\)(.*?)\$\$(.*?)\$\$;/i.exec(m0005);

  it('is a definer function with a locked search_path, a qualified table, 3 columns and a hard row cap', () => {
    expect(fn).not.toBeNull();
    const [, header, body] = fn!;
    expect(header).toContain('RETURNS TABLE (org_id uuid, import_job_id uuid, storage_key text)');
    expect(header).toContain('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
    expect(body).toContain('SELECT j.org_id, j.id, j.storage_key FROM public.import_job j');
    expect(body).toContain('LIMIT least(greatest(p_limit, 0), 500)');
    expect(m0005).toContain('ALTER FUNCTION app.import_files_due(integer) OWNER TO crm_definer;');
  });

  it('EXECUTE: revoked from PUBLIC and the shared roles, granted to crm_cleanup only', () => {
    expect(m0005).toContain('REVOKE ALL ON FUNCTION app.import_files_due(integer) FROM PUBLIC;');
    expect(m0005).toContain(
      'REVOKE ALL ON FUNCTION app.import_files_due(integer) FROM crm_app, crm_auth, crm_platform;',
    );
    expect(functionGrantees(migrations)).toEqual(['crm_cleanup']);
  });
});

// M5 (0006): export-file cleanup, the same pattern; approved 2026-10-24.
describe('app.export_files_due and app.export_file_deleted', () => {
  it('are definer functions with a locked search_path and qualified tables, owned by crm_definer', () => {
    for (const name of ['export_files_due', 'export_file_deleted']) {
      const fn = new RegExp(
        String.raw`CREATE FUNCTION app\.${name}\(([^)]*)\)(.*?)\$\$(.*?)\$\$;`,
        'i',
      ).exec(m0006);
      expect(fn, name).not.toBeNull();
      expect(fn![2], name).toContain('SECURITY DEFINER SET search_path = pg_catalog, pg_temp');
      expect(fn![3], name).toContain('public.export_job j');
    }
    expect(m0006).toContain('ALTER FUNCTION app.export_files_due(integer) OWNER TO crm_definer;');
    expect(m0006).toContain(
      'ALTER FUNCTION app.export_file_deleted(uuid, uuid) OWNER TO crm_definer;',
    );
    expect(m0006).toContain('LIMIT least(greatest(p_limit, 0), 500)');
  });

  it('EXECUTE: revoked from PUBLIC and the shared roles, granted to crm_cleanup only', () => {
    expect(m0006).toContain(
      'REVOKE ALL ON FUNCTION app.export_files_due(integer), app.export_file_deleted(uuid, uuid) FROM PUBLIC;',
    );
    expect(m0006).toContain(
      'REVOKE ALL ON FUNCTION app.export_files_due(integer), app.export_file_deleted(uuid, uuid) FROM crm_app, crm_auth, crm_platform;',
    );
    const grantees = [
      ...migrations.matchAll(/GRANT [^;]*? ON FUNCTION [^;]*?app\.export_file[^;]*? TO ([^;]+);/gi),
    ].flatMap((m) => m[1]!.split(',').map((x) => x.trim()));
    expect(grantees).toEqual(['crm_cleanup']);
  });
});

describe('crm_cleanup privileges', () => {
  it('migrations grant it exactly schema usage on app and EXECUTE on the cleanup functions', () => {
    const grants = [...migrations.matchAll(/GRANT [^;]*?crm_cleanup[^;]*;/gi)].map((m) => m[0]);
    expect(grants.sort()).toEqual([
      'GRANT EXECUTE ON FUNCTION app.export_files_due(integer), app.export_file_deleted(uuid, uuid) TO crm_cleanup;',
      'GRANT EXECUTE ON FUNCTION app.import_files_due(integer) TO crm_cleanup;',
      'GRANT USAGE ON SCHEMA app TO crm_cleanup;',
    ]);
    // No policy, ownership or membership names it.
    expect(migrations).not.toMatch(
      /POLICY [^;]*crm_cleanup|OWNER TO crm_cleanup|GRANT crm_cleanup/i,
    );
  });

  it('provisioning: login only, no elevated attributes, no inheritance, no memberships', () => {
    const create = /CREATE ROLE crm_cleanup ([^;]+);/.exec(provision)?.[1] ?? '';
    for (const attr of [
      'LOGIN',
      'NOSUPERUSER',
      'NOBYPASSRLS',
      'NOCREATEROLE',
      'NOCREATEDB',
      'NOREPLICATION',
      'NOINHERIT',
    ])
      expect(create.split(' '), attr).toContain(attr);
    // Re-asserted on every run; SUPERUSER/BYPASSRLS/REPLICATION are checked rather than set
    // (since PostgreSQL 16 only a superuser may name them, and managed admins are not superusers).
    expect(provision).toContain(
      'ALTER ROLE crm_cleanup LOGIN NOCREATEROLE NOCREATEDB NOINHERIT CONNECTION LIMIT 2;',
    );
    expect(normalise(provision)).toContain(
      "AND (rolsuper OR rolbypassrls OR rolreplication)) THEN RAISE EXCEPTION 'crm_cleanup must not be SUPERUSER, BYPASSRLS or REPLICATION",
    );
    // Its only grant is CONNECT on the database; it is granted no role and no other role it.
    const grants = [...provision.matchAll(/GRANT [^;]*;/gi)].map((m) => m[0]);
    expect(grants).toEqual(['GRANT CONNECT ON DATABASE :"db" TO crm_cleanup;']);
  });

  it('provisioning only ever sends a SCRAM verifier: plaintext is refused, a stale password is aligned', () => {
    expect(provision).not.toMatch(/cleanup_pw/);
    expect(provision).toContain("CREATE ROLE crm_cleanup LOGIN PASSWORD :'cleanup_verifier'");
    expect(provision).toContain("ALTER ROLE crm_cleanup PASSWORD :'cleanup_verifier';");
    expect(provision).toContain("~ '^SCRAM-SHA-256\\$");
    expect(provision).toMatch(/RAISE EXCEPTION 'cleanup_verifier is not a SCRAM-SHA-256 verifier/);
    expect(provision).toMatch(/RAISE EXCEPTION 'crm_cleanup does not exist/);
    const wrapper = read('scripts', 'db', 'provision-cleanup-role.mjs');
    expect(wrapper).toContain('input: scriptWithVerifier()'); // stdin, never argv
  });

  it('the local Docker init creates it with the same attributes, then runs the shared script', () => {
    const init = read('docker', 'postgres', 'init', '01-roles.sh');
    expect(init).toContain('-f /crm-sql/provision-cleanup-role.sql');
    expect(normalise(init)).toContain(
      "CREATE ROLE crm_cleanup LOGIN PASSWORD '${CRM_CLEANUP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT CONNECTION LIMIT 2;",
    );
    expect(init).not.toMatch(/GRANT[^\n]*crm_cleanup/);
  });
});
