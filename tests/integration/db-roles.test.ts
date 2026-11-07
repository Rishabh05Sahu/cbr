// Security regression: database roles, RLS coverage and role escalation (S1 rules on the
// production schema; D2 least privilege for crm_auth).
import { describe, expect, it } from 'vitest';
import { withRole, type RoleClient } from '../support/db';
import { neonContextFor } from '../support/neon-context';
import {
  DENIED,
  attemptSetRole,
  isAcceptedRefusal,
  type SetRoleOutcome,
} from '../support/set-role';

const APP = process.env.TEST_DATABASE_URL!;
const AUTH = process.env.TEST_AUTH_DATABASE_URL!;
const PLATFORM = process.env.TEST_PLATFORM_DATABASE_URL!;
const MIGRATOR = process.env.TEST_MIGRATOR_URL!;
const CLEANUP = process.env.TEST_CLEANUP_DATABASE_URL!;

const CRM_ROLES = [
  'crm_migrator',
  'crm_definer',
  'crm_app',
  'crm_auth',
  'crm_platform',
  'crm_cleanup',
];

// The role that administers the cluster: `postgres` locally; the managed runner passes the
// provider admin it bootstrapped with (Neon: neondb_owner, DigitalOcean: doadmin).
const PROVIDER_ADMIN = process.env.TEST_PROVIDER_ADMIN_ROLE || 'postgres';

// Predefined roles that grant access beyond RLS/grants (names absent in a version are ignored).
// Keep in step with PRIVILEGED_ROLES in scripts/managed-db/s1-managed-run.mjs.
const PREDEFINED_PRIVILEGED = [
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_execute_server_program',
  'pg_signal_backend',
  'pg_signal_autovacuum_worker',
  'pg_maintain',
  'pg_checkpoint',
  'pg_create_subscription',
  'pg_use_reserved_connections',
  'pg_monitor',
  'pg_read_all_settings',
  'pg_read_all_stats',
];

/**
 * Every privileged role that actually exists here: elevated attributes, the predefined roles
 * above, and any role that is a member of one of those (e.g. Neon's neon_superuser).
 */
async function privilegedRoles(c: RoleClient): Promise<string[]> {
  const { rows } = await c.query<{ rolname: string }>(
    `WITH p AS (
       SELECT oid FROM pg_roles
       WHERE rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
          OR rolname = ANY($1))
     SELECT r.rolname FROM pg_roles r
     WHERE r.rolname <> current_user
       AND (r.oid IN (SELECT oid FROM p)
            OR EXISTS (SELECT 1 FROM p WHERE pg_has_role(r.oid, p.oid, 'MEMBER')))
     ORDER BY 1`,
    [PREDEFINED_PRIVILEGED],
  );
  return rows.map((r) => r.rolname);
}

const AUTH_TABLES = [
  'account',
  'invitation',
  'organization',
  'organization_membership',
  'session',
  'two_factor',
  'user',
  'verification',
];

describe('RLS coverage on the production schema', () => {
  it('every table (except the migrations ledger) is RLS enabled + forced', async () => {
    const rows = await withRole(
      MIGRATOR,
      async (c) =>
        (
          await c.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND relname <> '_prisma_migrations' AND NOT (relrowsecurity AND relforcerowsecurity)`)
        ).rows,
    );
    expect(rows).toEqual([]);
  });

  it('every org_id table has a crm_app tenant policy', async () => {
    const rows = await withRole(
      MIGRATOR,
      async (c) =>
        (
          await c.query(`SELECT c.relname FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname AND 'crm_app' = ANY (p.roles))`)
        ).rows,
    );
    expect(rows).toEqual([]);
  });

  it('crm_app with no context sees 0 rows in every table it can read', async () => {
    await withRole(APP, async (c) => {
      const tables = (
        await c.query(`SELECT table_name FROM information_schema.role_table_grants
        WHERE grantee = 'crm_app' AND privilege_type = 'SELECT' AND table_schema = 'public'`)
      ).rows.map((r) => r.table_name);
      expect(tables.length).toBeGreaterThan(5);
      for (const t of tables) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM "${t}"`).catch(async () =>
          // column-level grants (user): count via a granted column
          c.query(`SELECT count(id)::int AS n FROM "${t}"`),
        );
        expect(rows[0].n, t).toBe(0);
      }
    });
  });
});

describe.each([
  ['crm_app', APP],
  ['crm_auth', AUTH],
  ['crm_platform', PLATFORM],
  ['crm_cleanup', CLEANUP],
])('%s hardening', (role, url) => {
  it('is not superuser, cannot bypass RLS, create roles/DBs, or inherit other roles', async () => {
    await withRole(url, async (c) => {
      const { rows } = await c.query(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
                (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships,
                (SELECT count(*)::int FROM pg_class WHERE relowner = r.oid) AS owned
         FROM pg_roles r WHERE rolname = current_user`,
      );
      expect(rows[0]).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        memberships: 0,
        owned: 0,
      });
    });
  });

  it.each(CRM_ROLES.filter((r) => r !== role))('cannot SET ROLE %s', async (target) => {
    await withRole(url, async (c) => {
      // A missing role must fail the test, never pass as a denial.
      const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [target]);
      expect(exists.rowCount, `role ${target} must exist`).toBe(1);
      // PostgreSQL's refusal (42501), and the effective role unchanged afterwards.
      expect(await attemptSetRole(c, target)).toEqual(DENIED);
    });
  });

  it(`privileged-role discovery is non-empty and includes the provider admin (${PROVIDER_ADMIN})`, async () => {
    await withRole(url, async (c) => {
      const privileged = await privilegedRoles(c);
      expect(privileged.length).toBeGreaterThan(0);
      expect(privileged).toContain(PROVIDER_ADMIN);
    });
  });

  it('is not a member of, and cannot SET ROLE to, any privileged role in the database', async () => {
    await withRole(url, async (c) => {
      const privileged = await privilegedRoles(c);
      expect(privileged).toContain(PROVIDER_ADMIN); // fail closed on an empty/wrong discovery
      const { rows: reachable } = await c.query(
        `SELECT rolname FROM pg_roles WHERE rolname = ANY($1) AND pg_has_role(current_user, oid, 'MEMBER')`,
        [privileged],
      );
      expect(reachable).toEqual([]);
      // Every attempt: PostgreSQL's refusal (42501) with current_user unchanged. Only in a Neon
      // context confirmed by the server itself (../support/neon-context.ts), and only for the
      // reviewed NEON_PROTECTED_ROLES, Neon's own refusal also counts (exact XX000 + exact
      // message + current_user unchanged + no membership; ../support/set-role.ts). Anything else
      // fails and is shown with its SQLSTATE.
      const neon = (await neonContextFor(c, process.env, url)) !== null;
      const outcomes: Record<string, SetRoleOutcome> = {};
      for (const target of privileged)
        outcomes[target] = await attemptSetRole(c, target, { neonContext: neon });
      console.info(
        `[db-roles] SET ROLE outcomes for ${role} (Neon context: ${neon}): ${JSON.stringify(outcomes)}`,
      );
      const verdicts = Object.fromEntries(
        privileged.map((r) => [
          r,
          isAcceptedRefusal(r, outcomes[r]!, neon) ? 'refused' : outcomes[r],
        ]),
      );
      expect(verdicts).toEqual(Object.fromEntries(privileged.map((r) => [r, 'refused'])));
    });
  });

  it('cannot create objects or disable RLS', async () => {
    await withRole(url, async (c) => {
      await expect(c.query('CREATE TABLE x (id int)')).rejects.toThrow(/permission denied/);
      await expect(c.query('ALTER TABLE organization DISABLE ROW LEVEL SECURITY')).rejects.toThrow(
        /must be owner/,
      );
    });
  });
});

describe('D2: crm_auth least privilege', () => {
  it('holds privileges on exactly the authentication/organisation tables', async () => {
    const rows = await withRole(MIGRATOR, async (c) =>
      (
        await c.query(`SELECT DISTINCT table_name FROM information_schema.role_table_grants
        WHERE grantee = 'crm_auth' AND table_schema = 'public' ORDER BY 1`)
      ).rows.map((r) => r.table_name),
    );
    expect(rows).toEqual(AUTH_TABLES);
  });

  it.each(['team', 'team_membership', 'audit_log', 'outbox_event', 'support_access_grant'])(
    'is denied on %s',
    async (t) => {
      await withRole(AUTH, async (c) => {
        await expect(c.query(`SELECT 1 FROM ${t} LIMIT 1`)).rejects.toThrow(/permission denied/);
      });
    },
  );

  it('cannot execute pre-tenant or relay functions', async () => {
    await withRole(AUTH, async (c) => {
      await expect(c.query(`SELECT * FROM app.outbox_claim(1, 30)`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});

describe('crm_app cannot reach credentials or sessions', () => {
  it.each(['session', 'account', 'verification', 'two_factor'])('denied on %s', async (t) => {
    await withRole(APP, async (c) => {
      await expect(c.query(`SELECT 1 FROM ${t} LIMIT 1`)).rejects.toThrow(/permission denied/);
    });
  });

  it('cannot write memberships/invitations directly (only via the auth library)', async () => {
    await withRole(APP, async (c) => {
      await expect(
        c.query(`INSERT INTO invitation (id, org_id, email, status, expires_at, inviter_id)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'x@y.z', 'pending', now(), gen_random_uuid())`),
      ).rejects.toThrow(/permission denied/);
      await expect(c.query(`UPDATE organization_membership SET role = 'owner'`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});

describe('crm_platform sees no tenant PII', () => {
  it.each([
    'user',
    'organization_membership',
    'invitation',
    'team',
    'team_membership',
    'outbox_event',
  ])('denied on %s', async (t) => {
    await withRole(PLATFORM, async (c) => {
      await expect(c.query(`SELECT 1 FROM "${t}" LIMIT 1`)).rejects.toThrow(/permission denied/);
    });
  });
});
