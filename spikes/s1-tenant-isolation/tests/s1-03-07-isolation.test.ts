// S1-03 fail closed, S1-04 tenant reads, S1-05 tenant writes, S1-06 composite FK,
// S1-07 transaction-local context.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppClient, createMigratorClient, tenantRunnerFor } from '../db/clients';
import { seedOrg, TENANT_DELEGATES, TENANT_TABLES, type OrgFixture } from './fixtures';

const migrator = createMigratorClient();
const app = createAppClient(5);
const { withTenant } = tenantRunnerFor(app);
let A: OrgFixture;
let B: OrgFixture;

beforeAll(async () => {
  A = await seedOrg(migrator, 'Alpha');
  B = await seedOrg(migrator, 'Bravo');
});
afterAll(async () => {
  await app.close();
  await migrator.close();
});

const ctxA = () => ({ orgId: A.orgId, userId: A.users.admin });

describe('S1-03 fail closed (crm_app, no app.org_id)', () => {
  it.each([...TENANT_TABLES, 'organization', 'user'])(
    'SELECT on %s returns 0 rows',
    async (table) => {
      const rows = await app.prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${table}"`,
      );
      expect(rows[0]!.n).toBe(0n);
    },
  );

  it('ORM reads on every tenant model return nothing', async () => {
    for (const d of TENANT_DELEGATES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- iterate delegates generically
      const n = await (app.prisma as any)[d].count();
      expect(n, d).toBe(0);
    }
  });

  it('INSERT raises (WITH CHECK), UPDATE/DELETE affect 0 rows', async () => {
    await expect(
      app.prisma
        .$executeRaw`INSERT INTO lead (org_id, full_name, primary_phone_e164) VALUES (${A.orgId}::uuid, 'x', '+919800000000')`,
    ).rejects.toThrow(/row-level security/);
    expect(await app.prisma.$executeRaw`UPDATE lead SET full_name = 'pwned'`).toBe(0);
    expect(await app.prisma.$executeRaw`DELETE FROM lead`).toBe(0);
    expect(await app.prisma.lead.updateMany({ data: { fullName: 'pwned' } })).toEqual({ count: 0 });
    expect(await app.prisma.lead.deleteMany({})).toEqual({ count: 0 });
  });

  it('an empty-string context (what PostgreSQL leaves after a local set) also matches nothing', async () => {
    const n = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.org_id', '', true)`;
      return tx.lead.count();
    });
    expect(n).toBe(0);
  });
});

describe('S1-04 tenant reads', () => {
  it('sanity: org A context sees its own rows in every tenant table', async () => {
    await withTenant(ctxA(), async (tx) => {
      for (const t of TENANT_TABLES) {
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`);
        expect(rows[0]!.n, t).toBeGreaterThan(0n);
      }
    });
  });

  it('org A context finds 0 rows of org B via ORM (by org_id and by known ids)', async () => {
    await withTenant(ctxA(), async (tx) => {
      for (const d of TENANT_DELEGATES) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- iterate delegates generically
        expect(await (tx as any)[d].count({ where: { orgId: B.orgId } }), d).toBe(0);
      }
      expect(await tx.lead.findUnique({ where: { id: B.leads.exec1! } })).toBeNull();
      expect(await tx.team.findUnique({ where: { id: B.teams.north } })).toBeNull();
      expect(await tx.importJob.findUnique({ where: { id: B.importJobId } })).toBeNull();
      expect(await tx.organization.findUnique({ where: { id: B.orgId } })).toBeNull();
      // Relation traversal from an A row cannot reach B either.
      const ownLeads = await tx.lead.findMany({
        select: { orgId: true, tasks: { select: { orgId: true } } },
      });
      expect(
        ownLeads.every((l) => l.orgId === A.orgId && l.tasks.every((t) => t.orgId === A.orgId)),
      ).toBe(true);
    });
  });

  it('org A context finds 0 rows of org B via raw SQL', async () => {
    await withTenant(ctxA(), async (tx) => {
      for (const t of TENANT_TABLES) {
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "${t}" WHERE org_id = $1::uuid`,
          B.orgId,
        );
        expect(rows[0]!.n, t).toBe(0n);
      }
      const byId = await tx.$queryRaw<
        unknown[]
      >`SELECT id FROM lead WHERE id = ${B.leads.exec1}::uuid`;
      expect(byId).toEqual([]);
    });
  });
});

describe('S1-05 tenant writes', () => {
  it('inserting a row with org_id = B fails (ORM and raw)', async () => {
    await expect(
      withTenant(ctxA(), (tx) =>
        tx.lead.create({ data: { orgId: B.orgId, fullName: 'x', phoneE164: '+919800000001' } }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(
        ctxA(),
        (tx) => tx.$executeRaw`INSERT INTO team (org_id, name) VALUES (${B.orgId}::uuid, 'x')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("updating/deleting B's rows affects 0 rows", async () => {
    await withTenant(ctxA(), async (tx) => {
      expect(
        await tx.lead.updateMany({ where: { id: B.leads.exec1! }, data: { fullName: 'pwned' } }),
      ).toEqual({ count: 0 });
      expect(await tx.lead.deleteMany({ where: { orgId: B.orgId } })).toEqual({ count: 0 });
      expect(
        await tx.$executeRaw`UPDATE task SET title = 'pwned' WHERE org_id = ${B.orgId}::uuid`,
      ).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM import_row WHERE org_id = ${B.orgId}::uuid`).toBe(0);
    });
    const untouched = await migrator.prisma.lead.findUnique({ where: { id: B.leads.exec1! } });
    expect(untouched?.fullName).not.toBe('pwned');
  });

  it('moving a row from A to B fails', async () => {
    await expect(
      withTenant(ctxA(), (tx) =>
        tx.lead.update({
          where: { id: A.leads.unassignedNorth! },
          data: { orgId: B.orgId, teamId: null },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(
        ctxA(),
        (tx) =>
          tx.$executeRaw`UPDATE interaction SET org_id = ${B.orgId}::uuid WHERE org_id = ${A.orgId}::uuid`,
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
  });
});

describe('S1-06 composite FK', () => {
  it("a task in org A referencing org B's lead fails at the FK even as crm_migrator", async () => {
    await expect(
      migrator.prisma.$executeRaw`
        INSERT INTO task (org_id, lead_id, assignee_user_id, title, due_at)
        VALUES (${A.orgId}::uuid, ${B.leads.exec1}::uuid, ${A.users.exec1}::uuid, 'x', now())`,
    ).rejects.toThrow(/task_org_id_lead_id_fkey/);
  });

  it('a lead in org A cannot be owned by a user who is only a member of org B', async () => {
    await expect(
      migrator.prisma.$executeRaw`
        INSERT INTO lead (org_id, full_name, primary_phone_e164, owner_user_id)
        VALUES (${A.orgId}::uuid, 'x', '+919800000002', ${B.users.exec1}::uuid)`,
    ).rejects.toThrow(/lead_org_id_owner_user_id_fkey/);
  });

  it('the same cross-org reference fails for crm_app inside org A context', async () => {
    await expect(
      withTenant(ctxA(), (tx) =>
        tx.task.create({
          data: {
            orgId: A.orgId,
            leadId: B.leads.exec1!,
            assigneeUserId: A.users.exec1,
            title: 'x',
            dueAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/foreign key|Foreign key/);
  });
});

describe('S1-07 transaction-local context', () => {
  const single = createAppClient(1);
  const runner = tenantRunnerFor(single);
  afterAll(() => single.close());

  const probe = async () =>
    (
      await single.prisma.$queryRaw<{ org: string | null; pid: number }[]>`
      SELECT current_setting('app.org_id', true) AS org, pg_backend_pid() AS pid`
    )[0]!;

  it('context is cleared on the same pooled connection after commit', async () => {
    const inside = await runner.withTenant(
      ctxA(),
      async (tx) =>
        (
          await tx.$queryRaw<{ org: string; pid: number }[]>`
        SELECT current_setting('app.org_id', true) AS org, pg_backend_pid() AS pid`
        )[0]!,
    );
    expect(inside.org).toBe(A.orgId);
    const after = await probe();
    expect(after.pid).toBe(inside.pid);
    expect(after.org ?? '').toBe('');
    expect(await single.prisma.lead.count()).toBe(0);
  });

  it('context is cleared on the same pooled connection after rollback (thrown error)', async () => {
    let pid = 0;
    await expect(
      runner.withTenant(ctxA(), async (tx) => {
        pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        await tx.lead.create({
          data: { orgId: A.orgId, fullName: 'rolled back', phoneE164: '+919800000003' },
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await probe();
    expect(after.pid).toBe(pid);
    expect(after.org ?? '').toBe('');
    const leaked = await migrator.prisma.lead.count({ where: { fullName: 'rolled back' } });
    expect(leaked).toBe(0);
  });

  it('invalid context ids are rejected before a connection is used', async () => {
    await expect(
      runner.withTenant({ orgId: "x' OR 1=1 --", userId: null }, async () => 1),
    ).rejects.toThrow(/orgId must be a UUID/);
  });
});
