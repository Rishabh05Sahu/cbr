// S1-15 scope layer (own/team/org), S1-16 assignment spells cannot overlap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppClient, createMigratorClient, tenantRunnerFor } from '../db/clients';
import { listLeads } from '../harness/lead-repository';
import { seedOrg, type OrgFixture } from './fixtures';

const migrator = createMigratorClient();
const app = createAppClient(3);
const { withTenant } = tenantRunnerFor(app);
let A: OrgFixture;
let B: OrgFixture;

beforeAll(async () => {
  A = await seedOrg(migrator, 'Kilo');
  B = await seedOrg(migrator, 'Lima');
});
afterAll(async () => {
  await app.close();
  await migrator.close();
});

const visible = async (who: keyof OrgFixture['users']) => {
  const rows = await withTenant({ orgId: A.orgId, userId: A.users[who] }, (tx) =>
    listLeads(tx, A.users[who], { take: 200 }),
  );
  return rows.map((r) => r.id).sort();
};
const ids = (...labels: string[]) => labels.map((l) => A.leads[l]!).sort();

describe('S1-15 scope layer', () => {
  it('Sales Executive: own leads only; reassigned-away lead not visible; expired delegation ignored', async () => {
    // exec1 used to own "reassigned" and had a delegation from exec3 that has expired.
    expect(await visible('exec1')).toEqual(ids('exec1'));
  });

  it('Sales Executive with active delegation: own + delegated leads', async () => {
    expect(await visible('exec2')).toEqual(ids('exec2', 'reassigned', 'exec3'));
  });

  it('Sales Executive in another team: own only', async () => {
    expect(await visible('exec3')).toEqual(ids('exec3'));
  });

  it('Sales Manager: led team (North) only, not a team they merely belong to (South)', async () => {
    expect(await visible('manager')).toEqual(
      ids('exec1', 'exec2', 'reassigned', 'unassignedNorth'),
    );
  });

  it('Admin and Owner: whole org, nothing from another org', async () => {
    const all = Object.values(A.leads).sort();
    expect(await visible('admin')).toEqual(all);
    expect(await visible('owner')).toEqual(all);
  });

  it('HR/Ops: no lead access', async () => {
    expect(await visible('hr')).toEqual([]);
  });

  it('ending a team-lead spell removes team scope immediately', async () => {
    const { id: mgrMembership } = (await migrator.prisma.organizationMembership.findFirst({
      where: { orgId: A.orgId, userId: A.users.manager },
    }))!;
    await migrator.prisma.teamMembership.updateMany({
      where: { orgId: A.orgId, membershipId: mgrMembership, teamRole: 'LEAD' },
      data: { endedAt: new Date() },
    });
    expect(await visible('manager')).toEqual([]);
  });

  it("a user from org B cannot use org A's context to see anything (no membership in A)", async () => {
    const rows = await withTenant({ orgId: A.orgId, userId: B.users.admin }, (tx) =>
      listLeads(tx, B.users.admin),
    );
    expect(rows).toEqual([]);
  });
});

describe('S1-16 ownership history', () => {
  it('an overlapping assignment spell is rejected by the exclusion constraint', async () => {
    await expect(
      withTenant({ orgId: A.orgId, userId: A.users.admin }, (tx) =>
        tx.leadAssignmentHistory.create({
          data: {
            orgId: A.orgId,
            leadId: A.leads.reassigned!,
            userId: A.users.exec3,
            startedAt: new Date(Date.now() - 86_400_000),
            source: 'MANUAL',
          },
        }),
      ),
    ).rejects.toThrow(/lead_assignment_history_no_overlap|exclusion constraint/);
  });

  it('closing the open spell, then starting a new one, is accepted', async () => {
    const at = new Date();
    await withTenant({ orgId: A.orgId, userId: A.users.admin }, async (tx) => {
      const closed = await tx.leadAssignmentHistory.updateMany({
        where: { leadId: A.leads.reassigned!, endedAt: null },
        data: { endedAt: at },
      });
      expect(closed.count).toBe(1);
      await tx.leadAssignmentHistory.create({
        data: {
          orgId: A.orgId,
          leadId: A.leads.reassigned!,
          userId: A.users.exec3,
          startedAt: at,
          source: 'MANUAL',
        },
      });
    });
    const spells = await migrator.prisma.leadAssignmentHistory.count({
      where: { leadId: A.leads.reassigned! },
    });
    expect(spells).toBe(3);
  });

  it('crm_app cannot rewrite history columns other than ended_at', async () => {
    await expect(
      withTenant(
        { orgId: A.orgId, userId: A.users.admin },
        (tx) => tx.$executeRaw`UPDATE lead_assignment_history SET user_id = ${A.users.exec1}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
