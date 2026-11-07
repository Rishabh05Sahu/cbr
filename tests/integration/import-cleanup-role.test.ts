// Phase 2 M4 security regression: the cross-org cleanup lookup (app.import_files_due) is
// reachable only through the dedicated crm_cleanup role, and crm_cleanup can do nothing else.
// crm_app, crm_auth and crm_platform cannot call it, and crm_app cannot read another org's
// import metadata by any other path. Synthetic data only. Needs migration 0005_imports and
// scripts/db/provision-cleanup-role.sql on crm_test.
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { importFilesDue } from '@/platform/db/cleanup';
import { migrator, withRole, type RoleClient } from '../support/db';
import { seedOrg } from '../support/factory';
import { DENIED, attemptSetRole } from '../support/set-role';

const APP = process.env.TEST_DATABASE_URL!;
const AUTH = process.env.TEST_AUTH_DATABASE_URL!;
const PLATFORM = process.env.TEST_PLATFORM_DATABASE_URL!;
const CLEANUP = process.env.TEST_CLEANUP_DATABASE_URL!;

const MINUTE = 60_000;
let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const jobs = {} as Record<'dueA' | 'dueB' | 'laterA' | 'deletedB', { id: string; key: string }>;

async function job(
  org: Awaited<ReturnType<typeof seedOrg>>,
  purgeInMs: number,
  deleted = false,
): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  const key = `orgs/${org.orgId}/imports/${id}/${randomBytes(16).toString('hex')}.csv`;
  // As the schema owner (maintenance policy): sets retention times the app could not.
  await migrator().importJob.create({
    data: {
      id,
      orgId: org.orgId,
      createdBy: org.users.owner.id,
      fileType: 'csv',
      contentType: 'text/csv',
      originalFilename: 'synthetic.csv',
      byteSize: 100,
      storageKey: key,
      purgeFileAfter: new Date(Date.now() + purgeInMs),
      fileDeletedAt: deleted ? new Date() : null,
    },
  });
  return { id, key };
}

const sqlstate = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code?: string }) => e.code ?? 'NO_CODE',
  );

beforeAll(async () => {
  A = await seedOrg('CleanupA');
  B = await seedOrg('CleanupB');
  jobs.dueA = await job(A, -10 * MINUTE);
  jobs.dueB = await job(B, -5 * MINUTE);
  jobs.laterA = await job(A, 60 * MINUTE);
  jobs.deletedB = await job(B, -20 * MINUTE, true);
});

describe('crm_cleanup: retrieves due files and nothing else', () => {
  it('lists due files across orgs: three columns, oldest first, not-due and deleted ones left out', async () => {
    await withRole(CLEANUP, async (c) => {
      const { rows, fields } = await c.query('SELECT * FROM app.import_files_due(500)');
      expect(fields.map((f) => f.name)).toEqual(['org_id', 'import_job_id', 'storage_key']);
      const ours = rows.filter((r) =>
        [jobs.dueA.id, jobs.dueB.id, jobs.laterA.id, jobs.deletedB.id].includes(r.import_job_id),
      );
      expect(ours).toEqual([
        { org_id: A.orgId, import_job_id: jobs.dueA.id, storage_key: jobs.dueA.key },
        { org_id: B.orgId, import_job_id: jobs.dueB.id, storage_key: jobs.dueB.key },
      ]);
    });
  });

  it('bounds the result count', async () => {
    await withRole(CLEANUP, async (c) => {
      expect((await c.query('SELECT * FROM app.import_files_due(-1)')).rows).toEqual([]);
      expect((await c.query('SELECT * FROM app.import_files_due(1)')).rows).toHaveLength(1);
    });
  });

  it('the worker gateway (CLEANUP_DATABASE_URL) returns the same rows', async () => {
    const due = await importFilesDue(500);
    expect(due).toEqual(
      expect.arrayContaining([
        { orgId: A.orgId, importJobId: jobs.dueA.id, storageKey: jobs.dueA.key },
        { orgId: B.orgId, importJobId: jobs.dueB.id, storageKey: jobs.dueB.key },
      ]),
    );
    expect(due.map((d) => d.importJobId)).not.toContain(jobs.laterA.id);
  });

  it('is not superuser, cannot bypass RLS, inherits nothing, is a member of nothing, owns nothing', async () => {
    await withRole(CLEANUP, async (c) => {
      const { rows } = await c.query(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit,
                rolcanlogin,
                (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships,
                (SELECT count(*)::int FROM pg_class WHERE relowner = r.oid) AS owned
         FROM pg_roles r WHERE rolname = current_user`,
      );
      expect(rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolinherit: false,
        rolcanlogin: true,
        memberships: 0,
        owned: 0,
      });
    });
  });

  it('cannot read any table, including import_job, lead and organization', async () => {
    await withRole(CLEANUP, async (c) => {
      const tables = (
        await c.query<{ t: string }>(
          `SELECT quote_ident(tablename) AS t FROM pg_tables WHERE schemaname = 'public'`,
        )
      ).rows.map((r) => r.t);
      expect(tables).toEqual(expect.arrayContaining(['import_job', 'lead', 'organization']));
      const outcomes = Object.fromEntries(
        await Promise.all(
          tables.map(async (t) => [t, await sqlstate(c.query(`SELECT 1 FROM ${t} LIMIT 1`))]),
        ),
      );
      expect(outcomes).toEqual(Object.fromEntries(tables.map((t) => [t, '42501'])));
    });
  });

  // M5 (0006, approved 2026-10-24) adds the two export-file cleanup functions; still an exact list.
  it('can execute exactly the three cleanup functions in schema app, and create nothing', async () => {
    await withRole(CLEANUP, async (c) => {
      const { rows } = await c.query(
        `SELECT p.proname FROM pg_proc p
         WHERE p.pronamespace = 'app'::regnamespace AND has_function_privilege(p.oid, 'EXECUTE')
         ORDER BY p.proname`,
      );
      expect(rows.map((r) => r.proname)).toEqual([
        'export_file_deleted',
        'export_files_due',
        'import_files_due',
      ]);
      expect(await sqlstate(c.query('CREATE TABLE public.x (id int)'))).toBe('42501');
      expect(await sqlstate(c.query('CREATE TABLE app.x (id int)'))).toBe('42501');
    });
  });

  it.each(['crm_definer', 'crm_app', 'crm_auth', 'crm_platform', 'crm_migrator'])(
    'cannot SET ROLE %s',
    async (target) => {
      await withRole(CLEANUP, async (c) => expect(await attemptSetRole(c, target)).toEqual(DENIED));
    },
  );
});

describe('other roles cannot reach the cleanup metadata', () => {
  it('EXECUTE is held only by the owner and crm_cleanup (not PUBLIC)', async () => {
    const rows = await migrator().$queryRaw<{ grantee: string }[]>`
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = 'app.import_files_due(integer)'::regprocedure AND a.privilege_type = 'EXECUTE'
      ORDER BY 1`;
    expect(rows.map((r) => r.grantee)).toEqual(['crm_cleanup', 'crm_definer']);
  });

  it.each([
    ['crm_app', APP],
    ['crm_auth', AUTH],
    ['crm_platform', PLATFORM],
  ])('%s cannot execute app.import_files_due', async (_, url) => {
    await withRole(url, async (c) => {
      expect(await sqlstate(c.query('SELECT * FROM app.import_files_due(10)'))).toBe('42501');
    });
  });

  it.each([
    ['crm_auth', AUTH],
    ['crm_platform', PLATFORM],
  ])('%s cannot read import_job', async (_, url) => {
    await withRole(url, async (c) => {
      expect(await sqlstate(c.query('SELECT 1 FROM import_job LIMIT 1'))).toBe('42501');
    });
  });

  it('crm_app sees no import jobs without a tenant, and only its own org with one', async () => {
    await withRole(APP, async (c) => {
      expect((await c.query('SELECT id FROM import_job')).rows).toEqual([]);
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('app.org_id', $1, true)`, [A.orgId]);
        const { rows } = await c.query('SELECT org_id, id FROM import_job ORDER BY id');
        expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([A.orgId]));
        expect(rows.map((r) => r.id).sort()).toEqual([jobs.dueA.id, jobs.laterA.id].sort());
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });

  it('crm_app cannot assume crm_cleanup or crm_definer, and no definer function it may call reads import_job', async () => {
    await withRole(APP, async (c: RoleClient) => {
      expect(await attemptSetRole(c, 'crm_cleanup')).toEqual(DENIED);
      expect(await attemptSetRole(c, 'crm_definer')).toEqual(DENIED);
      const { rows } = await c.query(
        `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p
         WHERE p.prosecdef AND has_function_privilege(p.oid, 'EXECUTE')
           AND p.prosrc ILIKE '%import_job%'`,
      );
      expect(rows).toEqual([]);
    });
  });
});
