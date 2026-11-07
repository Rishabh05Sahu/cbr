// Phase 2 M5 migration 0006: custom_field_definition, lead_duplicate_match, export_job and the
// lead archive/merge guard. Exercised as crm_app the way withTenant() connects (transaction-local
// app.org_id / app.user_id), plus the cleanup functions as crm_cleanup and privilege checks for
// every runtime role. Concurrency cases use two real connections with a fixed interleaving.
// Synthetic data only; crm_test only.
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrator, openRole, withRole, type QueryResult } from '../support/db';
import { seedOrg } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
const CLEANUP = process.env.TEST_CLEANUP_DATABASE_URL!;
const TABLES = ['custom_field_definition', 'lead_duplicate_match', 'export_job'] as const;

type Org = Awaited<ReturnType<typeof seedOrg>>;
let A: Org; // general
let B: Org; // the other tenant
let C: Org; // custom-field limit
let E: Org; // exports (every member promoted to owner, so each has its own daily quota)

interface Session {
  q: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/** An open crm_app transaction for `org` and `userId` (null = system actor). */
async function session(org: Org, userId: string | null, isolation = ''): Promise<Session> {
  const c = await openRole(APP);
  await c.query(`BEGIN${isolation ? ` ISOLATION LEVEL ${isolation}` : ''}`);
  await c.query(`SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`, [
    org.orgId,
    userId ?? '',
  ]);
  return {
    q: (sql, params = []) => c.query(sql, params),
    commit: async () => {
      await c.query('COMMIT');
      await c.end();
    },
    rollback: async () => {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    },
  };
}

/** One statement as crm_app in its own committed transaction. */
async function asApp(org: Org, userId: string | null, sql: string, params: unknown[] = []) {
  const s = await session(org, userId);
  try {
    const r = await s.q(sql, params);
    await s.commit();
    return r;
  } catch (e) {
    await s.rollback();
    throw e;
  }
}

/** 'OK', or the SQLSTATE of the failure. */
const state = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code?: string }) => e.code ?? 'NO_CODE',
  );

let phoneSeq = 0;
const sources = new Map<string, string>();
async function sourceFor(org: Org): Promise<string> {
  if (!sources.has(org.orgId)) {
    const s = await migrator().leadSource.create({
      data: { orgId: org.orgId, name: 'Synthetic Source' },
    });
    sources.set(org.orgId, s.id);
  }
  return sources.get(org.orgId)!;
}
/** A synthetic open lead, created as the schema owner. */
async function lead(org: Org, archived = false): Promise<string> {
  const digits = `97${String(10_000_000 + ++phoneSeq * 7907 + process.pid).slice(-8)}`;
  const l = await migrator().lead.create({
    data: {
      orgId: org.orgId,
      fullName: `Synthetic Lead ${phoneSeq}`,
      primaryPhoneE164: `+91${digits}`,
      primaryPhoneRaw: digits,
      phoneLast10: digits,
      sourceId: await sourceFor(org),
      archivedAt: archived ? new Date() : null,
    },
  });
  return l.id;
}
async function enquiry(org: Org, leadId: string): Promise<string> {
  const e = await migrator().leadEnquiry.create({
    data: { orgId: org.orgId, leadId, sourceId: await sourceFor(org) },
  });
  return e.id;
}

beforeAll(async () => {
  A = await seedOrg('HygA');
  B = await seedOrg('HygB');
  C = await seedOrg('HygC');
  E = await seedOrg('HygE');
  await migrator().member.updateMany({
    where: { organizationId: E.orgId },
    data: { role: 'owner' },
  });
});

// -------------------------------------------------------------------------------------------------
describe('0006 applied: RLS, policies and functions', () => {
  it('RLS is enabled and forced on every new table', async () => {
    const rows = await migrator().$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) ORDER BY relname`,
      [...TABLES],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows)
      expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('has exactly the reviewed policies, for crm_app, crm_migrator and crm_definer only', async () => {
    const rows = await migrator().$queryRawUnsafe<{ p: string }[]>(
      `SELECT tablename || '.' || policyname || ':' || permissive || ':' || cmd || ':' ||
              array_to_string(roles, ',') AS p
         FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])
        ORDER BY 1`,
      [[...TABLES, 'lead']],
    );
    expect(rows.map((r) => r.p)).toEqual([
      'custom_field_definition.actor_is_session_user:RESTRICTIVE:INSERT:crm_app',
      'custom_field_definition.maintenance:PERMISSIVE:ALL:crm_migrator',
      'custom_field_definition.tenant_isolation:PERMISSIVE:ALL:crm_app',
      'export_job.definer_lookup:PERMISSIVE:SELECT:crm_definer',
      'export_job.definer_mark:PERMISSIVE:UPDATE:crm_definer',
      'export_job.first_state_now:RESTRICTIVE:INSERT:crm_app',
      'export_job.maintenance:PERMISSIVE:ALL:crm_migrator',
      'export_job.owner_requests:RESTRICTIVE:INSERT:crm_app',
      'export_job.owner_updates:RESTRICTIVE:UPDATE:crm_app',
      'export_job.requester_only:RESTRICTIVE:ALL:crm_app',
      'export_job.tenant_isolation:PERMISSIVE:ALL:crm_app',
      // lead: unchanged by 0006
      'lead.actor_is_session_user:RESTRICTIVE:INSERT:crm_app',
      'lead.maintenance:PERMISSIVE:ALL:crm_migrator',
      'lead.tenant_isolation:PERMISSIVE:ALL:crm_app',
      'lead_duplicate_match.first_state_open:RESTRICTIVE:INSERT:crm_app',
      'lead_duplicate_match.maintenance:PERMISSIVE:ALL:crm_migrator',
      'lead_duplicate_match.resolver_is_session_user:RESTRICTIVE:UPDATE:crm_app',
      'lead_duplicate_match.tenant_isolation:PERMISSIVE:ALL:crm_app',
    ]);
  });

  it('functions: definers owned by crm_definer, triggers as invoker, fixed search_path', async () => {
    const rows = await migrator().$queryRawUnsafe<
      { proname: string; secdef: boolean; owner: string; config: string[] | null }[]
    >(
      `SELECT p.proname, p.prosecdef AS secdef, pg_get_userbyid(p.proowner) AS owner,
              p.proconfig AS config
         FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname = ANY($1::text[])
        ORDER BY p.proname`,
      [
        [
          'lead_hygiene_guard',
          'custom_field_limit',
          'duplicate_match_guard',
          'export_job_guard',
          'export_job_quota',
          'export_files_due',
          'export_file_deleted',
        ],
      ],
    );
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      expect(r.config, r.proname).toEqual(['search_path=pg_catalog, pg_temp']);
      const definer = r.proname.startsWith('export_file');
      expect(r.secdef, r.proname).toBe(definer);
      if (definer) expect(r.owner, r.proname).toBe('crm_definer');
    }
  });
});

// -------------------------------------------------------------------------------------------------
describe('0006 grants: least privilege', () => {
  const colPrivs = (grantee: string, table: string, priv: string) =>
    migrator()
      .$queryRawUnsafe<{ c: string }[]>(
        `SELECT column_name AS c FROM information_schema.column_privileges
          WHERE grantee = $1 AND table_schema = 'public' AND table_name = $2 AND privilege_type = $3
          ORDER BY 1`,
        grantee,
        table,
        priv,
      )
      .then((r) => r.map((x) => x.c));

  it('crm_app: SELECT and INSERT, column-limited UPDATE, never DELETE', async () => {
    for (const t of TABLES) {
      const r = await migrator().$queryRawUnsafe<Record<string, boolean>[]>(
        `SELECT has_table_privilege('crm_app', $1, 'SELECT') s, has_table_privilege('crm_app', $1, 'INSERT') i,
                has_table_privilege('crm_app', $1, 'UPDATE') u, has_table_privilege('crm_app', $1, 'DELETE') d,
                has_table_privilege('crm_app', $1, 'TRUNCATE') t`,
        `public.${t}`,
      );
      expect(r[0], t).toEqual({ s: true, i: true, u: false, d: false, t: false });
    }
    expect(await colPrivs('crm_app', 'custom_field_definition', 'UPDATE')).toEqual([
      'archived_at',
      'label',
      'options',
      'position',
      'required',
      'updated_at',
      'version',
    ]);
    expect(await colPrivs('crm_app', 'lead_duplicate_match', 'UPDATE')).toEqual([
      'resolved_at',
      'resolved_by',
      'status',
    ]);
    expect(await colPrivs('crm_app', 'export_job', 'UPDATE')).toEqual([
      'downloaded_at',
      'error_code',
      'expires_at',
      'filters',
      'finished_at',
      'purge_file_after',
      'row_count',
      'sha256',
      'started_at',
      'status',
      'updated_at',
      'version',
    ]);
  });

  it('lead: archive, merge pointer and custom values are updatable; deleted_at is not (D4)', async () => {
    const cols = await colPrivs('crm_app', 'lead', 'UPDATE');
    expect(cols).toEqual(
      expect.arrayContaining(['archived_at', 'merged_into_lead_id', 'custom_fields']),
    );
    expect(cols).not.toContain('deleted_at');
    expect(cols).not.toContain('org_id');
    const [d] = await migrator().$queryRawUnsafe<{ d: boolean }[]>(
      `SELECT has_table_privilege('crm_app', 'public.lead', 'DELETE') d`,
    );
    expect(d!.d).toBe(false);
  });

  it('crm_auth, crm_platform and crm_cleanup have no access to the new tables', async () => {
    for (const role of ['crm_auth', 'crm_platform', 'crm_cleanup'])
      for (const t of TABLES) {
        const [r] = await migrator().$queryRawUnsafe<{ any: boolean }[]>(
          `SELECT has_any_column_privilege($1, $2, 'SELECT, INSERT, UPDATE, REFERENCES') OR
                  has_table_privilege($1, $2, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS any`,
          role,
          `public.${t}`,
        );
        expect(r!.any, `${role} on ${t}`).toBe(false);
      }
  });

  it('crm_definer: only the cleanup columns of export_job', async () => {
    expect(await colPrivs('crm_definer', 'export_job', 'SELECT')).toEqual([
      'error_code',
      'file_deleted_at',
      'filters',
      'id',
      'org_id',
      'purge_file_after',
      'status',
      'storage_key',
    ]);
    expect(await colPrivs('crm_definer', 'export_job', 'UPDATE')).toEqual([
      'error_code',
      'file_deleted_at',
      'filters',
      'status',
      'updated_at',
    ]);
    for (const t of ['custom_field_definition', 'lead_duplicate_match'])
      expect(await colPrivs('crm_definer', t, 'SELECT'), t).toEqual([]);
  });

  it('EXECUTE on the export cleanup functions: crm_cleanup only (and the owning definer)', async () => {
    const rows = await migrator().$queryRawUnsafe<{ f: string; r: string; ok: boolean }[]>(
      `SELECT p.proname AS f, r.rolname AS r, has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS ok
         FROM pg_proc p CROSS JOIN pg_roles r
        WHERE p.pronamespace = 'app'::regnamespace
          AND p.proname IN ('export_files_due', 'export_file_deleted')
          AND r.rolname IN ('crm_app', 'crm_auth', 'crm_platform', 'crm_cleanup')
        ORDER BY 1, 2`,
    );
    for (const row of rows) expect(row.ok, `${row.r} ${row.f}`).toBe(row.r === 'crm_cleanup');
    const [pub] = await migrator().$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE p.pronamespace = 'app'::regnamespace AND a.grantee = 0 AND p.proname = ANY($1::text[])`,
      [
        'lead_hygiene_guard',
        'custom_field_limit',
        'duplicate_match_guard',
        'export_job_guard',
        'export_job_quota',
        'export_files_due',
        'export_file_deleted',
      ],
    );
    expect(pub!.n).toBe(0); // nothing new is executable by PUBLIC
  });

  it('crm_cleanup can execute exactly the three cleanup functions in schema app', async () => {
    const rows = await migrator().$queryRawUnsafe<{ f: string }[]>(
      `SELECT p.proname AS f FROM pg_proc p
        WHERE p.pronamespace = 'app'::regnamespace AND has_function_privilege('crm_cleanup', p.oid, 'EXECUTE')
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.f)).toEqual([
      'export_file_deleted',
      'export_files_due',
      'import_files_due',
    ]);
  });
});

// -------------------------------------------------------------------------------------------------
describe('0006 tenant isolation: cross-org negative controls', () => {
  const key = (org: Org, id: string) =>
    `orgs/${org.orgId}/exports/${id}/${randomBytes(16).toString('hex')}.csv`;

  it('org A cannot read, change or create org B rows in any new table', async () => {
    const bLead1 = await lead(B);
    const bLead2 = await lead(B);
    const field = randomUUID();
    await asApp(
      B,
      B.users.owner.id,
      `INSERT INTO custom_field_definition (id, org_id, key, label, type, created_by)
       VALUES ($1, $2, 'b_only', 'B only', 'text', $3)`,
      [field, B.orgId, B.users.owner.id],
    );
    const match = randomUUID();
    await asApp(
      B,
      B.users.owner.id,
      `INSERT INTO lead_duplicate_match (id, org_id, match_type, lead_id, candidate_lead_id, detected_by)
       VALUES ($1, $2, 'EMAIL', $3, $4, $5)`,
      [match, B.orgId, bLead1, bLead2, B.users.owner.id],
    );
    const job = randomUUID();
    await asApp(
      B,
      B.users.owner.id,
      `INSERT INTO export_job (id, org_id, requested_by, storage_key) VALUES ($1, $2, $3, $4)`,
      [job, B.orgId, B.users.owner.id, key(B, job)],
    );

    for (const [t, id] of [
      ['custom_field_definition', field],
      ['lead_duplicate_match', match],
      ['export_job', job],
    ] as const) {
      const seen = await asApp(A, A.users.owner.id, `SELECT 1 FROM ${t} WHERE id = $1`, [id]);
      expect(seen.rowCount, t).toBe(0);
      const all = await asApp(A, A.users.owner.id, `SELECT 1 FROM ${t} WHERE org_id = $1`, [
        B.orgId,
      ]);
      expect(all.rowCount, t).toBe(0);
    }
    expect(
      (
        await asApp(
          A,
          A.users.owner.id,
          `UPDATE custom_field_definition SET label = 'x' WHERE id = $1`,
          [field],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await asApp(
          A,
          A.users.owner.id,
          `UPDATE lead_duplicate_match SET status = 'DISMISSED', resolved_by = $2, resolved_at = now() WHERE id = $1`,
          [match, A.users.owner.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await asApp(A, A.users.owner.id, `UPDATE export_job SET status = 'FAILED' WHERE id = $1`, [
          job,
        ])
      ).rowCount,
    ).toBe(0);
    // A system session without an org context sees nothing.
    await withRole(APP, async (c) => {
      for (const t of TABLES) expect((await c.query(`SELECT 1 FROM ${t}`)).rowCount, t).toBe(0);
    });
  });

  it('inserting a row for another org is refused; a case cannot name another org’s leads', async () => {
    expect(
      await state(
        asApp(
          A,
          A.users.owner.id,
          `INSERT INTO custom_field_definition (org_id, key, label, type, created_by) VALUES ($1, 'x_field', 'X', 'text', $2)`,
          [B.orgId, A.users.owner.id],
        ),
      ),
    ).toBe('42501');
    const id = randomUUID();
    expect(
      await state(
        asApp(
          A,
          A.users.owner.id,
          `INSERT INTO export_job (id, org_id, requested_by, storage_key) VALUES ($1, $2, $3, $4)`,
          [id, B.orgId, A.users.owner.id, key(B, id)],
        ),
      ),
    ).toBe('42501');
    const aLead = await lead(A);
    const bLead = await lead(B);
    expect(
      await state(
        asApp(
          A,
          A.users.owner.id,
          `INSERT INTO lead_duplicate_match (org_id, match_type, lead_id, candidate_lead_id, detected_by)
           VALUES ($1, 'EMAIL', $2, $3, $4)`,
          [A.orgId, aLead, bLead, A.users.owner.id],
        ),
      ),
    ).toMatch(/^(23503|23514)$/);
  });
});

// -------------------------------------------------------------------------------------------------
describe('lead archive and merge guard (D1, D4)', () => {
  const upd = (set: string, id: string, params: unknown[] = []) =>
    asApp(A, A.users.owner.id, `UPDATE lead SET ${set} WHERE id = $1`, [id, ...params]);

  it('archive time is the transaction time; restore clears it', async () => {
    const l = await lead(A);
    expect(await state(upd(`archived_at = now() - interval '1 day'`, l))).toBe('23514');
    expect(await state(upd(`archived_at = now() + interval '1 day'`, l))).toBe('23514');
    expect(await state(upd(`archived_at = now()`, l))).toBe('OK');
    expect(await state(upd(`archived_at = NULL`, l))).toBe('OK');
  });

  it('deleted_at is not updatable by the application (hard delete excluded)', async () => {
    expect(await state(upd(`deleted_at = now()`, await lead(A)))).toBe('42501');
  });

  it('a merged lead is a frozen tombstone and cannot be unmerged', async () => {
    const [m, s] = [await lead(A), await lead(A)];
    expect(await state(upd(`merged_into_lead_id = $2`, m, [s]))).toBe('OK');
    expect(await state(upd(`full_name = 'Changed'`, m))).toBe('23514');
    expect(await state(upd(`merged_into_lead_id = NULL`, m))).toBe('23514');
    expect(await state(upd(`archived_at = now()`, m))).toBe('23514');
    // The survivor is unaffected.
    expect(await state(upd(`full_name = 'Survivor'`, s))).toBe('OK');
  });

  it('the merge target must be a live, unmerged, unarchived lead of the same org', async () => {
    const tomb = await lead(A);
    const live = await lead(A);
    await upd(`merged_into_lead_id = $2`, tomb, [live]);
    expect(await state(upd(`merged_into_lead_id = $2`, await lead(A), [tomb]))).toBe('23514');
    expect(await state(upd(`merged_into_lead_id = $2`, await lead(A), [await lead(A, true)]))).toBe(
      '23514',
    );
    expect(await state(upd(`merged_into_lead_id = $2`, await lead(A), [await lead(B)]))).toMatch(
      /^(23514|23503)$/,
    );
    const self = await lead(A);
    expect(await state(upd(`merged_into_lead_id = $2`, self, [self]))).toMatch(/^(23514)$/);
  });

  it('concurrent crossing merges (X into Y, Y into X) never both commit: no cycle', async () => {
    const [x, y] = [await lead(A), await lead(A)];
    const t1 = await session(A, A.users.owner.id);
    const t2 = await session(A, A.users.admin.id);
    await t1.q(`UPDATE lead SET merged_into_lead_id = $2 WHERE id = $1`, [x, y]); // locks X and Y
    const second = state(t2.q(`UPDATE lead SET merged_into_lead_id = $2 WHERE id = $1`, [y, x]));
    await new Promise((r) => setTimeout(r, 300)); // t2 is now waiting on t1's lock on Y
    await t1.commit();
    expect(await second).toBe('23514'); // re-checked X after t1 committed: X is merged
    await t2.rollback();
    const rows = await migrator().lead.findMany({
      where: { id: { in: [x, y] } },
      select: { id: true, mergedIntoLeadId: true },
    });
    expect(rows.find((r) => r.id === x)!.mergedIntoLeadId).toBe(y);
    expect(rows.find((r) => r.id === y)!.mergedIntoLeadId).toBeNull();
  });

  it('truly simultaneous crossing merges: at most one wins, never a cycle (10 rounds)', async () => {
    for (let i = 0; i < 10; i++) {
      const [x, y] = [await lead(A), await lead(A)];
      const run = async (from: string, to: string, user: string) => {
        const s = await session(A, user);
        try {
          await s.q(`UPDATE lead SET merged_into_lead_id = $2 WHERE id = $1`, [from, to]);
          await s.commit();
          return 'OK';
        } catch (e) {
          await s.rollback();
          return (e as { code?: string }).code;
        }
      };
      const results = await Promise.all([run(x, y, A.users.owner.id), run(y, x, A.users.admin.id)]);
      expect(results.filter((r) => r === 'OK').length).toBeLessThanOrEqual(1);
      for (const r of results) expect(r).toMatch(/^(OK|23514|40P01)$/);
      const both = await migrator().lead.count({
        where: { id: { in: [x, y] }, mergedIntoLeadId: { not: null } },
      });
      expect(both).toBeLessThanOrEqual(1);
    }
  });

  it('timeline types ARCHIVED, RESTORED and MERGED are accepted', async () => {
    const l = await lead(A);
    for (const type of ['ARCHIVED', 'RESTORED', 'MERGED'])
      expect(
        await state(
          asApp(
            A,
            A.users.owner.id,
            `INSERT INTO lead_activity (org_id, lead_id, type, actor_id, occurred_at) VALUES ($1, $2, $3, $4, now())`,
            [A.orgId, l, type, A.users.owner.id],
          ),
        ),
        type,
      ).toBe('OK');
  });
});

// -------------------------------------------------------------------------------------------------
describe('custom field definitions (D5)', () => {
  const INSERT = `INSERT INTO custom_field_definition (org_id, key, label, type, options, created_by)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)`;
  const add = (org: Org, k: string, type = 'text', options = '[]', by = org.users.owner.id) =>
    asApp(org, org.users.owner.id, INSERT, [org.orgId, k, `Label ${k}`, type, options, by]);

  it('created by the session user, at the transaction time', async () => {
    expect(await state(add(A, 'site_visit_pref'))).toBe('OK');
    expect(await state(add(A, 'by_someone_else', 'text', '[]', A.users.admin.id))).toBe('42501');
    expect(
      await state(
        asApp(
          A,
          A.users.owner.id,
          `INSERT INTO custom_field_definition (org_id, key, label, type, created_by, created_at)
           VALUES ($1, 'backdated', 'B', 'text', $2, now() - interval '1 day')`,
          [A.orgId, A.users.owner.id],
        ),
      ),
    ).toBe('42501');
  });

  it.each([
    ['a select without options', 'single_select', '[]'],
    ['a text field with options', 'text', '["a"]'],
    ['a non-string option', 'multi_select', '["a", 2]'],
    ['an empty option', 'single_select', '[""]'],
    ['a 101-character option', 'single_select', `["${'x'.repeat(101)}"]`],
    ['an unknown type', 'currency', '[]'],
  ])('refuses %s', async (_, type, options) => {
    expect(await state(add(A, `f_${randomBytes(4).toString('hex')}`, type, options))).toBe('23514');
  });

  it.each([['Bad-Key'], ['1abc'], ['a']])('refuses key %j', async (k) => {
    expect(await state(add(A, k))).toBe('23514');
  });

  it('keys are never reused, and key and type are never updatable', async () => {
    await add(A, 'reused_key');
    expect(await state(add(A, 'reused_key'))).toBe('23505');
    for (const set of [`key = 'other_key'`, `type = 'number'`, `org_id = '${B.orgId}'`])
      expect(
        await state(
          asApp(
            A,
            A.users.owner.id,
            `UPDATE custom_field_definition SET ${set} WHERE key = 'reused_key'`,
          ),
        ),
        set,
      ).toBe('42501');
  });

  it('at most 30 active per org; a concurrent 30th/31st pair cannot both commit', async () => {
    for (let i = 1; i <= 29; i++)
      expect(await state(add(C, `field_${i}`)), `field_${i}`).toBe('OK');
    const t1 = await session(C, C.users.owner.id);
    const t2 = await session(C, C.users.owner.id);
    await t1.q(INSERT, [C.orgId, 'field_30a', 'L', 'text', '[]', C.users.owner.id]);
    const second = state(t2.q(INSERT, [C.orgId, 'field_30b', 'L', 'text', '[]', C.users.owner.id]));
    await new Promise((r) => setTimeout(r, 300)); // t2 waits on the per-org advisory lock
    await t1.commit();
    expect(await second).toBe('23514');
    await t2.rollback();
    expect(
      await migrator().customFieldDefinition.count({ where: { orgId: C.orgId, archivedAt: null } }),
    ).toBe(30);
    expect(await state(add(C, 'field_31'))).toBe('23514');
    // Other orgs are unaffected by C's count.
    expect(await state(add(B, 'b_field_ok'))).toBe('OK');
  });

  it('archiving frees a slot; un-archiving past the limit is refused', async () => {
    await asApp(
      C,
      C.users.owner.id,
      `UPDATE custom_field_definition SET archived_at = now() WHERE key = 'field_1'`,
    );
    expect(await state(add(C, 'field_new'))).toBe('OK');
    expect(
      await state(
        asApp(
          C,
          C.users.owner.id,
          `UPDATE custom_field_definition SET archived_at = NULL WHERE key = 'field_1'`,
        ),
      ),
    ).toBe('23514');
  });

  it('REPEATABLE READ is refused (it could miss a concurrent insert)', async () => {
    const s = await session(A, A.users.owner.id, 'REPEATABLE READ');
    expect(
      await state(s.q(INSERT, [A.orgId, 'rr_field', 'L', 'text', '[]', A.users.owner.id])),
    ).toBe('25000');
    await s.rollback();
  });

  it('lead custom values must be a JSON object of at most 16 KB', async () => {
    const l = await lead(A);
    const set = (v: string) =>
      state(
        asApp(A, A.users.owner.id, `UPDATE lead SET custom_fields = $2::jsonb WHERE id = $1`, [
          l,
          v,
        ]),
      );
    expect(await set('{"site_visit_pref": "weekend"}')).toBe('OK');
    expect(await set('[1, 2]')).toBe('23514');
    expect(await set(JSON.stringify({ big: randomBytes(20_000).toString('hex') }))).toBe('23514');
  });
});

// -------------------------------------------------------------------------------------------------
describe('duplicate review queue (D2)', () => {
  const PAIR = `INSERT INTO lead_duplicate_match (id, org_id, match_type, lead_id, candidate_lead_id, detected_by)
    VALUES ($1, $2, $3, $4, $5, $6)`;
  const pair = async (
    l1: string,
    l2: string,
    by: string | null = A.users.owner.id,
    type = 'PHONE_ALT',
  ) => {
    const id = randomUUID();
    await asApp(A, by, PAIR, [id, A.orgId, type, l1, l2, by]);
    return id;
  };
  const resolve = (id: string, status: string, by = A.users.owner.id, resolvedBy = by) =>
    asApp(
      A,
      by,
      `UPDATE lead_duplicate_match SET status = $2, resolved_by = $3, resolved_at = now()
        WHERE id = $1 AND status = 'OPEN'`,
      [id, status, resolvedBy],
    );

  it('cases start OPEN, attributed to the session user or the system', async () => {
    expect(await state(pair(await lead(A), await lead(A)))).toBe('OK');
    expect(await state(pair(await lead(A), await lead(A), null))).toBe('OK');
    const [l1, l2] = [await lead(A), await lead(A)];
    expect(
      await state(
        asApp(A, A.users.owner.id, PAIR, [
          randomUUID(),
          A.orgId,
          'EMAIL',
          l1,
          l2,
          A.users.admin.id,
        ]),
      ),
    ).toBe('42501');
    expect(
      await state(
        asApp(
          A,
          A.users.owner.id,
          `INSERT INTO lead_duplicate_match (org_id, match_type, lead_id, candidate_lead_id, status, resolved_by, resolved_at, detected_by)
           VALUES ($1, 'EMAIL', $2, $3, 'DISMISSED', $4, now(), $4)`,
          [A.orgId, l1, l2, A.users.owner.id],
        ),
      ),
    ).toMatch(/^(42501|23514)$/);
  });

  it('one case per unordered pair; no self-pairs; never a merged lead', async () => {
    const [l1, l2] = [await lead(A), await lead(A)];
    await pair(l1, l2);
    expect(await state(pair(l2, l1))).toBe('23505');
    expect(await state(pair(l1, l1))).toBe('23514');
    const [t, s] = [await lead(A), await lead(A)];
    await asApp(A, A.users.owner.id, `UPDATE lead SET merged_into_lead_id = $2 WHERE id = $1`, [
      t,
      s,
    ]);
    expect(await state(pair(t, await lead(A)))).toBe('23514');
    expect(await state(pair(await lead(A), t))).toBe('23514');
  });

  it('resolved once, by the session user, at the transaction time', async () => {
    const id = await pair(await lead(A), await lead(A));
    expect(await state(resolve(id, 'DISMISSED', A.users.owner.id, A.users.admin.id))).toBe('42501');
    expect((await resolve(id, 'DISMISSED')).rowCount).toBe(1);
    expect((await resolve(id, 'MERGED')).rowCount).toBe(0);
    expect(
      (
        await asApp(
          A,
          A.users.owner.id,
          `UPDATE lead_duplicate_match SET status = 'OPEN', resolved_by = NULL, resolved_at = NULL WHERE id = $1`,
          [id],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('two concurrent resolvers: exactly one resolution is recorded', async () => {
    const id = await pair(await lead(A), await lead(A));
    const SQL = `UPDATE lead_duplicate_match SET status = 'DISMISSED', resolved_by = $2, resolved_at = now()
      WHERE id = $1 AND status = 'OPEN'`;
    const t1 = await session(A, A.users.owner.id);
    const t2 = await session(A, A.users.admin.id);
    expect((await t1.q(SQL, [id, A.users.owner.id])).rowCount).toBe(1);
    const second = t2.q(SQL, [id, A.users.admin.id]);
    await new Promise((r) => setTimeout(r, 300));
    await t1.commit();
    expect((await second).rowCount).toBe(0);
    await t2.commit();
    const row = await migrator().leadDuplicateMatch.findUniqueOrThrow({ where: { id } });
    expect(row.resolvedBy).toBe(A.users.owner.id);
  });

  it('MERGED is recorded only after one lead was really merged into the other', async () => {
    const [l1, l2] = [await lead(A), await lead(A)];
    const id = await pair(l1, l2);
    expect(await state(resolve(id, 'MERGED'))).toBe('23514');
    const s = await session(A, A.users.owner.id);
    await s.q(`UPDATE lead SET merged_into_lead_id = $2 WHERE id = $1`, [l2, l1]);
    await s.q(
      `UPDATE lead_duplicate_match SET status = 'MERGED', resolved_by = $2, resolved_at = now() WHERE id = $1`,
      [id, A.users.owner.id],
    );
    await s.commit();
    expect((await migrator().leadDuplicateMatch.findUniqueOrThrow({ where: { id } })).status).toBe(
      'MERGED',
    );
  });

  it('pair cases cannot take archived outcomes', async () => {
    const id = await pair(await lead(A), await lead(A));
    expect(await state(resolve(id, 'RESTORED'))).toBe('23514');
  });

  describe('archived enquiry cases: never auto-restored', () => {
    const ARCH = `INSERT INTO lead_duplicate_match (id, org_id, match_type, lead_id, enquiry_id, detected_by)
      VALUES ($1, $2, 'ARCHIVED_ENQUIRY', $3, $4, $5)`;
    const open = async (leadId: string, enquiryId: string) => {
      const id = randomUUID();
      await asApp(A, A.users.owner.id, ARCH, [id, A.orgId, leadId, enquiryId, A.users.owner.id]);
      return id;
    };

    it('needs an archived lead and an enquiry of that lead', async () => {
      const live = await lead(A);
      expect(await state(open(live, await enquiry(A, live)))).toBe('23514');
      const arch = await lead(A, true);
      const other = await lead(A);
      expect(await state(open(arch, await enquiry(A, other)))).toBe('23514');
      expect(
        await state(
          asApp(
            A,
            A.users.owner.id,
            `INSERT INTO lead_duplicate_match (org_id, match_type, lead_id, candidate_lead_id, detected_by)
             VALUES ($1, 'ARCHIVED_ENQUIRY', $2, $3, $4)`,
            [A.orgId, arch, other, A.users.owner.id],
          ),
        ),
      ).toBe('23514');
      expect(await state(open(arch, await enquiry(A, arch)))).toBe('OK');
    });

    it('one open case per archived lead; one case per enquiry', async () => {
      const arch = await lead(A, true);
      const e1 = await enquiry(A, arch);
      await open(arch, e1);
      expect(await state(open(arch, await enquiry(A, arch)))).toBe('23505');
    });

    it('RESTORED needs the lead restored; KEPT_ARCHIVED needs it still archived', async () => {
      const arch = await lead(A, true);
      const c1 = await open(arch, await enquiry(A, arch));
      expect(await state(resolve(c1, 'RESTORED'))).toBe('23514');
      expect(await state(resolve(c1, 'MERGED'))).toBe('23514');
      expect((await resolve(c1, 'KEPT_ARCHIVED')).rowCount).toBe(1);
      // The lead is still archived: nothing restored it.
      expect(
        (await migrator().lead.findUniqueOrThrow({ where: { id: arch } })).archivedAt,
      ).not.toBeNull();

      const c2 = await open(arch, await enquiry(A, arch));
      const s = await session(A, A.users.owner.id);
      await s.q(`UPDATE lead SET archived_at = NULL WHERE id = $1`, [arch]);
      await s.q(
        `UPDATE lead_duplicate_match SET status = 'RESTORED', resolved_by = $2, resolved_at = now() WHERE id = $1`,
        [c2, A.users.owner.id],
      );
      await s.commit();
      expect(
        (await migrator().lead.findUniqueOrThrow({ where: { id: arch } })).archivedAt,
      ).toBeNull();
    });
  });
});

// -------------------------------------------------------------------------------------------------
describe('export jobs (D3)', () => {
  const sha = randomBytes(32);
  const key = (org: Org, id: string) =>
    `orgs/${org.orgId}/exports/${id}/${randomBytes(16).toString('hex')}.csv`;
  const INSERT = `INSERT INTO export_job (id, org_id, requested_by, storage_key, filters) VALUES ($1, $2, $3, $4, $5::jsonb)`;
  const newJob = async (user: string, filters = '{"stages":["NEW"]}', org = E) => {
    const id = randomUUID();
    await asApp(org, user, INSERT, [id, org.orgId, user, key(org, id), filters]);
    return id;
  };
  const upd = (user: string, id: string, set: string, params: unknown[] = []) =>
    asApp(E, user, `UPDATE export_job SET ${set} WHERE id = $1`, [id, ...params]);
  const toRunning = (user: string, id: string) =>
    upd(user, id, `status = 'RUNNING', started_at = now()`);
  const toReady = (user: string, id: string, window = `interval '10 minutes'`) =>
    upd(
      user,
      id,
      `status = 'READY', finished_at = now(), expires_at = now() + ${window}, row_count = 3, sha256 = $2`,
      [sha],
    );
  /** The download claim: READY -> DOWNLOADED, dropping the search text, matched only while READY. */
  const claim = (user: string, id: string) =>
    asApp(
      E,
      user,
      `UPDATE export_job SET status = 'DOWNLOADED', downloaded_at = now(), filters = filters - 'q'
        WHERE id = $1 AND status = 'READY'`,
      [id],
    );

  it('Owner only: an admin or executive cannot request an export', async () => {
    for (const u of [A.users.admin.id, A.users.exec1.id]) {
      const id = randomUUID();
      expect(await state(asApp(A, u, INSERT, [id, A.orgId, u, key(A, id), '{}'])), u).toBe('42501');
    }
    expect(await state(newJob(A.users.owner.id, '{}', A))).toBe('OK');
  });

  it('only the requester sees a job, even another owner of the same org', async () => {
    const id = await newJob(E.users.owner.id);
    expect(
      (await asApp(E, E.users.owner.id, `SELECT 1 FROM export_job WHERE id = $1`, [id])).rowCount,
    ).toBe(1);
    expect(
      (await asApp(E, E.users.admin.id, `SELECT 1 FROM export_job WHERE id = $1`, [id])).rowCount,
    ).toBe(0);
    expect((await upd(E.users.admin.id, id, `status = 'FAILED'`)).rowCount).toBe(0);
    expect((await asApp(E, null, `SELECT 1 FROM export_job WHERE id = $1`, [id])).rowCount).toBe(0);
  });

  it.each([
    ['a later status', 'status', `'READY'`, '42501'],
    ['a backdated creation', 'created_at', `now() - interval '1 hour'`, '42501'],
    ['a result already set', 'row_count', '3', '42501'],
    ['a download time', 'downloaded_at', 'now()', '42501'],
    ['retention beyond one hour', 'purge_file_after', `now() + interval '61 minutes'`, '23514'],
    ['oversized filters', 'filters', `jsonb_build_object('stages', repeat('x', 5000))`, '23514'],
  ])('refuses an insert with %s', async (_, col, val, code) => {
    const u = E.users.owner.id;
    const id = randomUUID();
    const sql = `INSERT INTO export_job (id, org_id, requested_by, storage_key, ${col})
      VALUES ($1, $2, $3, $4, ${val})`;
    expect(await state(asApp(E, u, sql, [id, E.orgId, u, key(E, id)]))).toBe(code);
  });

  it('refuses a job naming another requester', async () => {
    const id = randomUUID();
    const u = E.users.owner.id;
    expect(
      await state(asApp(E, u, INSERT, [id, E.orgId, E.users.admin.id, key(E, id), '{}'])),
    ).toBe('42501');
  });

  it('the storage key must name this org and job under exports/', async () => {
    const id = randomUUID();
    const u = E.users.owner.id;
    for (const bad of [
      key(B, id),
      `orgs/${E.orgId}/imports/${id}/${randomBytes(16).toString('hex')}.csv`,
      `orgs/${E.orgId}/exports/${randomUUID()}/${randomBytes(16).toString('hex')}.csv`,
      `orgs/${E.orgId}/exports/${id}/${randomBytes(16).toString('hex')}.xlsx`,
    ])
      expect(await state(asApp(E, u, INSERT, [id, E.orgId, u, bad, '{}'])), bad).toBe('23514');
  });

  it('5 requests per requester per 24 hours', async () => {
    const u = E.users.exec2.id;
    for (let i = 0; i < 5; i++) expect(await state(newJob(u))).toBe('OK');
    expect(await state(newJob(u))).toBe('23514');
    expect(await state(newJob(E.users.manager.id))).toBe('OK'); // per requester
  });

  it('times are the transaction time and the window is at most 15 minutes', async () => {
    const u = E.users.manager.id;
    const id = await newJob(u);
    expect(
      await state(upd(u, id, `status = 'RUNNING', started_at = now() - interval '1 minute'`)),
    ).toBe('23514');
    expect(await state(upd(u, id, `status = 'READY'`))).toBe('23514'); // QUEUED -> READY
    await toRunning(u, id);
    expect(await state(toReady(u, id, `interval '16 minutes'`))).toBe('23514');
    expect(
      await state(
        upd(
          u,
          id,
          `status = 'READY', finished_at = now() - interval '5 minutes', expires_at = now(), row_count = 1, sha256 = $2`,
          [sha],
        ),
      ),
    ).toBe('23514');
    expect(
      await state(
        upd(
          u,
          id,
          `status = 'READY', finished_at = now(), expires_at = now() + interval '5 minutes'`,
        ),
      ),
    ).toBe('23514'); // no result
    expect(await state(toReady(u, id))).toBe('OK');
    expect(await state(upd(u, id, `row_count = 4`))).toBe('23514'); // result fixed once ready
    expect(
      await state(upd(u, id, `purge_file_after = purge_file_after + interval '1 minute'`)),
    ).toBe('23514');
    expect(
      await state(upd(u, id, `purge_file_after = purge_file_after - interval '1 minute'`)),
    ).toBe('OK');
    expect(await state(upd(u, id, `file_deleted_at = now()`))).toBe('42501'); // cleanup only
  });

  it('single use: two simultaneous claims record exactly one download', async () => {
    const u = E.users.hr.id;
    const id = await newJob(u);
    await toRunning(u, id);
    await toReady(u, id);
    const SQL = `UPDATE export_job SET status = 'DOWNLOADED', downloaded_at = now(), filters = filters - 'q'
      WHERE id = $1 AND status = 'READY'`;
    const t1 = await session(E, u);
    const t2 = await session(E, u);
    expect((await t1.q(SQL, [id])).rowCount).toBe(1);
    const second = t2.q(SQL, [id]);
    await new Promise((r) => setTimeout(r, 300));
    await t1.commit();
    expect((await second).rowCount).toBe(0);
    await t2.commit();
    expect((await claim(u, id)).rowCount).toBe(0); // and never again
    expect(await state(upd(u, id, `status = 'READY'`))).toBe('23514'); // frozen
  });

  it('a download after the window has closed is refused', async () => {
    const u = E.users.hr.id;
    const id = await newJob(u);
    await toRunning(u, id);
    await toReady(u, id, `interval '1 second'`);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(
      await state(
        upd(u, id, `status = 'DOWNLOADED', downloaded_at = now(), filters = filters - 'q'`),
      ),
    ).toBe('23514');
    expect(
      await state(upd(u, id, `status = 'DOWNLOADED', downloaded_at = now() - interval '1 second'`)),
    ).toBe('23514');
  });

  it('a demoted owner can no longer build or download their job', async () => {
    const u = E.users.admin.id;
    const id = await newJob(u);
    await migrator().member.updateMany({
      where: { organizationId: E.orgId, userId: u },
      data: { role: 'admin' },
    });
    try {
      expect((await toRunning(u, id)).rowCount).toBe(0);
    } finally {
      await migrator().member.updateMany({
        where: { organizationId: E.orgId, userId: u },
        data: { role: 'owner' },
      });
    }
    expect((await toRunning(u, id)).rowCount).toBe(1);
  });

  describe('search text (A1)', () => {
    const F = '{"q":"9000000001","stages":["NEW"]}';
    it('cannot finish while the search text is stored', async () => {
      const u = E.users.exec1.id;
      const id = await newJob(u, F);
      await toRunning(u, id);
      expect(await state(upd(u, id, `status = 'FAILED', error_code = 'X'`))).toBe('23514');
      await toReady(u, id);
      expect(await state(upd(u, id, `status = 'DOWNLOADED', downloaded_at = now()`))).toBe('23514');
      expect(await state(claim(u, id))).toBe('OK');
      const row = await migrator().exportJob.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'DOWNLOADED', filters: { stages: ['NEW'] } });
      expect(JSON.stringify(row.filters)).not.toContain('9000000001');
    });

    it('filters can only lose the search text, and stay frozen once finished', async () => {
      const u = E.users.exec1.id;
      const id = await newJob(u, F);
      expect(await state(upd(u, id, `filters = filters || '{"city":"Pune"}'`))).toBe('23514');
      expect(await state(upd(u, id, `filters = '{}'`))).toBe('23514');
      expect(await state(upd(u, id, `filters = filters - 'q'`))).toBe('OK');
      expect(await state(upd(u, id, `status = 'FAILED', error_code = 'X'`))).toBe('OK');
      expect(await state(upd(u, id, `filters = '{"q":"back"}'`))).toBe('23514');
    });
  });
});

// -------------------------------------------------------------------------------------------------
describe('export file cleanup (crm_cleanup only)', () => {
  const ids = {} as Record<
    'queued' | 'running' | 'ready' | 'downloaded' | 'later' | 'otherOrg',
    string
  >;
  const keys = {} as Record<keyof typeof ids, string>;

  /**
   * As the schema owner (maintenance policy; sets times the app could not): a job created 2 h ago
   * whose file was due 90 minutes ago, with optional extra columns.
   */
  async function due(
    org: Org,
    user: string,
    name: keyof typeof ids,
    extra: Record<string, string> = {},
  ) {
    const id = randomUUID();
    const k = `orgs/${org.orgId}/exports/${id}/${randomBytes(16).toString('hex')}.csv`;
    const cols = Object.keys(extra)
      .map((c) => `, ${c}`)
      .join('');
    const vals = Object.values(extra)
      .map((v) => `, ${v}`)
      .join('');
    await migrator().$executeRawUnsafe(
      `INSERT INTO export_job (id, org_id, requested_by, storage_key, filters, created_at, purge_file_after${cols})
       VALUES ($1, $2, $3, $4, $5::jsonb, now() - interval '2 hours',
               now() - interval '90 minutes'${vals})`,
      id,
      org.orgId,
      user,
      k,
      // A finished job never holds the search text (export_job_guard A1); unfinished ones may.
      extra.status === `'DOWNLOADED'` ? '{"stages":["NEW"]}' : '{"q":"Synthetic","stages":["NEW"]}',
    );
    ids[name] = id;
    keys[name] = k;
  }

  beforeAll(async () => {
    // A's manager (not E's members) so E's quotas above are not affected.
    await migrator().member.updateMany({
      where: { organizationId: A.orgId, userId: A.users.manager.id },
      data: { role: 'owner' },
    });
    const u = A.users.manager.id;
    const finished = {
      started_at: `now() - interval '119 minutes'`,
      finished_at: `now() - interval '110 minutes'`,
      expires_at: `now() - interval '100 minutes'`,
      row_count: '1',
      sha256: `decode(repeat('ab', 32), 'hex')`,
    };
    await due(A, u, 'queued');
    await due(A, u, 'running', {
      status: `'RUNNING'`,
      started_at: `now() - interval '119 minutes'`,
    });
    await due(A, u, 'ready', { status: `'READY'`, ...finished });
    await due(A, u, 'downloaded', {
      status: `'DOWNLOADED'`,
      ...finished,
      downloaded_at: `now() - interval '105 minutes'`,
    });
    // Created now with the default one-hour purge: not due.
    ids.later = randomUUID();
    keys.later = `orgs/${A.orgId}/exports/${ids.later}/${randomBytes(16).toString('hex')}.csv`;
    await asApp(
      A,
      A.users.owner.id,
      `INSERT INTO export_job (id, org_id, requested_by, storage_key) VALUES ($1, $2, $3, $4)`,
      [ids.later, A.orgId, A.users.owner.id, keys.later],
    );
    await due(B, B.users.owner.id, 'otherOrg');
  });

  it('lists due files across orgs: ids and keys only, not-due ones left out', async () => {
    await withRole(CLEANUP, async (c) => {
      const { rows, fields } = await c.query('SELECT * FROM app.export_files_due(500)');
      expect(fields.map((f) => f.name)).toEqual(['org_id', 'export_job_id', 'storage_key']);
      const ours = rows.filter((r) => Object.values(ids).includes(r.export_job_id));
      expect(ours.map((r) => r.export_job_id).sort()).toEqual(
        [ids.queued, ids.running, ids.ready, ids.downloaded, ids.otherOrg].sort(),
      );
      const other = ours.find((r) => r.export_job_id === ids.otherOrg);
      expect(other).toEqual({
        org_id: B.orgId,
        export_job_id: ids.otherOrg,
        storage_key: keys.otherOrg,
      });
      expect((await c.query('SELECT * FROM app.export_files_due(-1)')).rows).toEqual([]);
    });
  });

  it('crm_cleanup cannot read or write export_job directly', async () => {
    await withRole(CLEANUP, async (c) => {
      expect(await state(c.query('SELECT 1 FROM export_job'))).toBe('42501');
      expect(await state(c.query(`UPDATE export_job SET file_deleted_at = now()`))).toBe('42501');
    });
  });

  it('crm_app cannot call either cleanup function', async () => {
    expect(await state(asApp(A, A.users.owner.id, 'SELECT * FROM app.export_files_due(10)'))).toBe(
      '42501',
    );
    expect(
      await state(
        asApp(A, A.users.owner.id, 'SELECT app.export_file_deleted($1, $2)', [A.orgId, ids.queued]),
      ),
    ).toBe('42501');
  });

  it('marks only a due job of the given org, closes it and drops the search text', async () => {
    await withRole(CLEANUP, async (c) => {
      const mark = async (org: string, id: string) =>
        (await c.query('SELECT app.export_file_deleted($1, $2) AS ok', [org, id])).rows[0]
          .ok as boolean;
      expect(await mark(B.orgId, ids.queued)).toBe(false); // wrong org
      expect(await mark(A.orgId, ids.later)).toBe(false); // not due
      expect(await mark(A.orgId, ids.queued)).toBe(true);
      expect(await mark(A.orgId, ids.queued)).toBe(false); // once
      expect(await mark(A.orgId, ids.running)).toBe(true);
      expect(await mark(A.orgId, ids.ready)).toBe(true);
      expect(await mark(A.orgId, ids.downloaded)).toBe(true);
    });
    const rows = await migrator().exportJob.findMany({
      where: { id: { in: [ids.queued, ids.running, ids.ready, ids.downloaded, ids.later] } },
    });
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by(ids.queued)).toMatchObject({ status: 'EXPIRED', filters: { stages: ['NEW'] } });
    expect(by(ids.running)).toMatchObject({ status: 'FAILED', errorCode: 'EXPIRED_BEFORE_READY' });
    expect(by(ids.ready).status).toBe('EXPIRED');
    expect(by(ids.downloaded).status).toBe('DOWNLOADED');
    for (const id of [ids.queued, ids.running, ids.ready, ids.downloaded]) {
      expect(by(id).fileDeletedAt, id).not.toBeNull();
      expect(JSON.stringify(by(id).filters), id).not.toContain('"q"');
    }
    expect(by(ids.later).fileDeletedAt).toBeNull();
    await withRole(CLEANUP, async (c) => {
      const left = (await c.query('SELECT export_job_id FROM app.export_files_due(500)')).rows.map(
        (r) => r.export_job_id,
      );
      expect(left).toContain(ids.otherOrg);
      for (const id of [ids.queued, ids.running, ids.ready, ids.downloaded])
        expect(left).not.toContain(id);
    });
  });
});
