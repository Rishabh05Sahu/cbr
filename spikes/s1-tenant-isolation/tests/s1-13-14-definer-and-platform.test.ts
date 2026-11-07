// S1-13 pre-tenant SECURITY DEFINER functions, S1-14 platform-scoped tables.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAppClient,
  createMigratorClient,
  createPlatformClient,
  tenantRunnerFor,
} from '../db/clients';
import { seedOrg, type OrgFixture } from './fixtures';

const migrator = createMigratorClient();
const app = createAppClient(3);
const platform = createPlatformClient();
const { withTenant, withUser } = tenantRunnerFor(app);
let A: OrgFixture;
let B: OrgFixture;

beforeAll(async () => {
  A = await seedOrg(migrator, 'India');
  B = await seedOrg(migrator, 'Juliet');
});
afterAll(async () => {
  await Promise.all([app.close(), platform.close(), migrator.close()]);
});

const FUNCTIONS = {
  auth_memberships_for_user: ['org_id', 'membership_id', 'role_code', 'status'],
  resolve_webhook_connection: ['org_id', 'connection_id', 'provider'],
  resolve_share_token: ['org_id', 'share_id', 'expires_at'],
  resolve_invitation: ['org_id', 'invitation_id', 'email', 'status', 'expires_at'],
} as const;

describe('S1-13 pre-tenant functions: definition', () => {
  it('each is SECURITY DEFINER, owned by NOLOGIN crm_definer, with fixed search_path', async () => {
    const rows = await app.prisma.$queryRaw<
      { name: string; secdef: boolean; owner: string; canlogin: boolean; config: string[] | null }[]
    >`
      SELECT p.proname AS name, p.prosecdef AS secdef, r.rolname AS owner, r.rolcanlogin AS canlogin,
             p.proconfig AS config
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.pronamespace = 'app'::regnamespace AND p.proname = ANY (${Object.keys(FUNCTIONS)}::text[])
      ORDER BY 1`;
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r, r.name).toMatchObject({ secdef: true, owner: 'crm_definer', canlogin: false });
      expect(r.config, r.name).toEqual(['search_path=pg_catalog, pg_temp']);
    }
  });

  it('crm_definer can read only the minimum columns (no secrets)', async () => {
    const [p] = await app.prisma.$queryRaw<{ secret: boolean; full_membership: boolean }[]>`
      SELECT has_column_privilege('crm_definer', 'integration_connection', 'secret_ciphertext', 'SELECT') AS secret,
             has_table_privilege('crm_definer', 'organization_membership', 'SELECT') AS full_membership`;
    expect(p).toEqual({ secret: false, full_membership: false });
  });

  it('EXECUTE is granted to crm_app only (not PUBLIC, not crm_platform)', async () => {
    await expect(
      platform.prisma.$queryRaw`SELECT * FROM app.resolve_webhook_connection('x')`,
    ).rejects.toThrow(/permission denied/);
  });
});

describe('S1-13 pre-tenant functions: behaviour', () => {
  it('functions return exactly the documented columns', async () => {
    const m = await withUser(
      A.users.exec1,
      (tx) =>
        tx.$queryRaw<
          Record<string, unknown>[]
        >`SELECT * FROM app.auth_memberships_for_user(${A.users.exec1}::uuid)`,
    );
    expect(Object.keys(m[0]!).sort()).toEqual([...FUNCTIONS.auth_memberships_for_user].sort());
    const w = await app.prisma.$queryRaw<
      Record<string, unknown>[]
    >`SELECT * FROM app.resolve_webhook_connection(${A.connectionTokenHash})`;
    expect(Object.keys(w[0]!).sort()).toEqual([...FUNCTIONS.resolve_webhook_connection].sort());
    const s = await app.prisma.$queryRaw<
      Record<string, unknown>[]
    >`SELECT * FROM app.resolve_share_token(${A.shareTokenHash})`;
    expect(Object.keys(s[0]!).sort()).toEqual([...FUNCTIONS.resolve_share_token].sort());
    const i = await app.prisma.$queryRaw<
      Record<string, unknown>[]
    >`SELECT * FROM app.resolve_invitation(${A.invitationTokenHash})`;
    expect(Object.keys(i[0]!).sort()).toEqual([...FUNCTIONS.resolve_invitation].sort());
  });

  it('auth_memberships_for_user: own memberships only; another user id returns nothing', async () => {
    const own = await withUser(
      A.users.exec1,
      (tx) =>
        tx.$queryRaw<
          { org_id: string }[]
        >`SELECT org_id FROM app.auth_memberships_for_user(${A.users.exec1}::uuid)`,
    );
    expect(own.map((r) => r.org_id)).toEqual([A.orgId]);
    const other = await withUser(
      A.users.exec1,
      (tx) =>
        tx.$queryRaw<
          unknown[]
        >`SELECT * FROM app.auth_memberships_for_user(${B.users.owner}::uuid)`,
    );
    expect(other).toEqual([]);
    const noContext = await app.prisma.$queryRaw<unknown[]>`
      SELECT * FROM app.auth_memberships_for_user(${A.users.exec1}::uuid)`;
    expect(noContext).toEqual([]);
  });

  it('token lookups match the exact token only and cannot enumerate', async () => {
    const probes = [
      '',
      '%',
      '_',
      '*',
      A.connectionTokenHash.slice(0, 10),
      `${A.connectionTokenHash} `,
      "' OR '1'='1",
    ];
    for (const fn of ['resolve_webhook_connection', 'resolve_share_token', 'resolve_invitation']) {
      for (const probe of probes) {
        const rows = await app.prisma.$queryRawUnsafe<unknown[]>(
          `SELECT * FROM app.${fn}($1)`,
          probe,
        );
        expect(rows, `${fn}(${probe})`).toEqual([]);
      }
      const nullRows = await app.prisma.$queryRawUnsafe<unknown[]>(`SELECT * FROM app.${fn}(NULL)`);
      expect(nullRows, `${fn}(NULL)`).toEqual([]);
    }
    const a = await app.prisma.$queryRaw<
      { org_id: string }[]
    >`SELECT org_id FROM app.resolve_share_token(${A.shareTokenHash})`;
    const b = await app.prisma.$queryRaw<
      { org_id: string }[]
    >`SELECT org_id FROM app.resolve_invitation(${B.invitationTokenHash})`;
    expect(a.map((r) => r.org_id)).toEqual([A.orgId]);
    expect(b.map((r) => r.org_id)).toEqual([B.orgId]);
  });

  it('crm_app cannot impersonate crm_definer or read its tables directly', async () => {
    await expect(app.prisma.$executeRaw`SET ROLE crm_definer`).rejects.toThrow(/permission denied/);
    expect(await app.prisma.$queryRaw`SELECT * FROM integration_connection`).toEqual([]);
  });
});

describe('S1-14 platform tables', () => {
  it('user: own row via withUser; org members via withTenant; other orgs invisible', async () => {
    const own = await withUser(B.users.owner, (tx) => tx.user.findMany({ select: { id: true } }));
    expect(own.map((u) => u.id)).toEqual([B.users.owner]);

    const inA = await withTenant({ orgId: A.orgId, userId: A.users.exec1 }, (tx) =>
      tx.user.findMany({ select: { id: true } }),
    );
    expect(inA.map((u) => u.id).sort()).toEqual(Object.values(A.users).sort());
    expect(inA.some((u) => Object.values(B.users).includes(u.id))).toBe(false);

    expect(await app.prisma.user.count()).toBe(0);
  });

  it('user: a user can update only their own row', async () => {
    const res = await withTenant({ orgId: A.orgId, userId: A.users.exec1 }, (tx) =>
      tx.user.updateMany({ where: { id: A.users.exec2 }, data: { name: 'pwned' } }),
    );
    expect(res.count).toBe(0);
  });

  it('organization: crm_app sees only the current org; crm_platform sees all', async () => {
    const seen = await withTenant({ orgId: A.orgId, userId: A.users.admin }, (tx) =>
      tx.organization.findMany({ select: { id: true } }),
    );
    expect(seen.map((o) => o.id)).toEqual([A.orgId]);
    const all = await platform.prisma.organization.findMany({
      where: { id: { in: [A.orgId, B.orgId] } },
    });
    expect(all).toHaveLength(2);
  });

  it('audit_log: NULL-org rows invisible to crm_app; crm_platform sees only NULL-org rows', async () => {
    await platform.prisma.auditLog.create({
      data: { action: 'platform.org_created', entityType: 'organization', entityId: A.orgId },
    });
    const appRows = await withTenant({ orgId: A.orgId, userId: A.users.admin }, (tx) =>
      tx.auditLog.findMany({ select: { orgId: true } }),
    );
    expect(appRows.length).toBeGreaterThan(0);
    expect(appRows.every((r) => r.orgId === A.orgId)).toBe(true);

    const platformRows = await platform.prisma.auditLog.findMany({ select: { orgId: true } });
    expect(platformRows.length).toBeGreaterThan(0);
    expect(platformRows.every((r) => r.orgId === null)).toBe(true);

    await expect(
      withTenant({ orgId: A.orgId, userId: A.users.admin }, (tx) =>
        tx.auditLog.create({ data: { action: 'x', entityType: 'x' } }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('audit_log is append-only for crm_app and crm_platform', async () => {
    await expect(
      withTenant(
        { orgId: A.orgId, userId: A.users.admin },
        (tx) => tx.$executeRaw`DELETE FROM audit_log`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(platform.prisma.$executeRaw`UPDATE audit_log SET action = 'x'`).rejects.toThrow(
      /permission denied/,
    );
  });

  it('crm_platform has no access to tenant PII tables', async () => {
    await expect(platform.prisma.$queryRaw`SELECT * FROM lead LIMIT 1`).rejects.toThrow(
      /permission denied/,
    );
    await expect(platform.prisma.$queryRaw`SELECT * FROM "user" LIMIT 1`).rejects.toThrow(
      /permission denied/,
    );
  });
});
