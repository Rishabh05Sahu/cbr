// S1-01 role hardening, S1-02 RLS enabled + forced (coverage rule), checked from the catalog.
import { afterAll, describe, expect, it } from 'vitest';
import { createAppClient } from '../db/clients';
import { TENANT_TABLES } from './fixtures';

const app = createAppClient(1);
afterAll(() => app.close());

describe('S1-01 role hardening', () => {
  it('crm_app is not superuser, cannot bypass RLS, cannot create roles or databases', async () => {
    const rows = await app.prisma.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }[]
    >`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([
      { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false },
    ]);
  });

  it('crm_app owns no relations, functions or schemas', async () => {
    const [owned] = await app.prisma.$queryRaw<{ rels: bigint; funcs: bigint; schemas: bigint }[]>`
      SELECT
        (SELECT count(*) FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS rels,
        (SELECT count(*) FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS funcs,
        (SELECT count(*) FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS schemas`;
    expect(owned).toEqual({ rels: 0n, funcs: 0n, schemas: 0n });
  });

  it('crm_app has no CREATE on schemas public/app or on the database', async () => {
    const [p] = await app.prisma.$queryRaw<{ pub: boolean; app: boolean; db: boolean }[]>`
      SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS pub,
             has_schema_privilege(current_user, 'app', 'CREATE') AS app,
             has_database_privilege(current_user, current_database(), 'CREATE') AS db`;
    expect(p).toEqual({ pub: false, app: false, db: false });
  });

  it('crm_app is not a member of any other role (no inherited privileges)', async () => {
    const rows = await app.prisma.$queryRaw<{ role: string }[]>`
      SELECT r.rolname AS role FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
    expect(rows).toEqual([]);
  });
});

describe('S1-02 RLS enabled and forced', () => {
  it('every public table with an org_id column has relrowsecurity AND relforcerowsecurity', async () => {
    const offenders = await app.prisma.$queryRaw<{ table: string }[]>`
      SELECT c.relname AS table
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`;
    expect(offenders).toEqual([]);
  });

  it('platform tables organization and user are also RLS-forced', async () => {
    const rows = await app.prisma.$queryRaw<{ relname: string; on: boolean }[]>`
      SELECT relname, (relrowsecurity AND relforcerowsecurity) AS on
      FROM pg_class WHERE relname IN ('organization', 'user') AND relnamespace = 'public'::regnamespace
      ORDER BY relname`;
    expect(rows).toEqual([
      { relname: 'organization', on: true },
      { relname: 'user', on: true },
    ]);
  });

  it('the representative suite covers every org_id table (no untested tenant table)', async () => {
    const rows = await app.prisma.$queryRaw<{ table: string }[]>`
      SELECT c.relname AS table
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
      ORDER BY 1`;
    expect(rows.map((r) => r.table)).toEqual([...TENANT_TABLES].sort());
  });

  it('every tenant table has a crm_app policy (RLS on with no policy would hide misconfiguration)', async () => {
    const rows = await app.prisma.$queryRaw<{ table: string }[]>`
      SELECT t AS table FROM unnest(${[...TENANT_TABLES]}::text[]) AS t
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = t AND 'crm_app' = ANY (p.roles))`;
    expect(rows).toEqual([]);
  });
});
