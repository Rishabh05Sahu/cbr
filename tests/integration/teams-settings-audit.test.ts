// Teams, org settings, profile and audit modules.
import { beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { listAudit } from '@/modules/audit';
import { getOrgSettings, updateOrgSettings } from '@/modules/organizations';
import { getMyProfile, updateMyProfile } from '@/modules/profile';
import * as teams from '@/modules/teams';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

let org: Awaited<ReturnType<typeof seedOrg>>;
const a: Record<string, Actor> = {};
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof ZodError) return 'VALIDATION_FAILED';
    throw e;
  }
};

beforeAll(async () => {
  org = await seedOrg('Teams');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(org.users[k], org.orgId);
});

describe('teams', () => {
  let north: string;

  it('Owner/Admin manage teams; others cannot', async () => {
    north = (await teams.createTeam(a.admin!.ctx, { name: 'North Pune' })).id;
    for (const k of ['manager', 'exec1', 'hr'])
      expect(await code(teams.createTeam(a[k]!.ctx, { name: `x-${k}` })), k).toBe('FORBIDDEN');
    expect(await code(teams.createTeam(a.owner!.ctx, { name: 'north pune' }))).toBe('CONFLICT');
  });

  it('only managers/admins/owners can lead; executives can be members', async () => {
    await teams.addTeamMember(a.admin!.ctx, {
      teamId: north,
      membershipId: org.membership.manager!,
      teamRole: 'LEAD',
    });
    await teams.addTeamMember(a.admin!.ctx, { teamId: north, membershipId: org.membership.exec1! });
    expect(
      await code(
        teams.addTeamMember(a.admin!.ctx, {
          teamId: north,
          membershipId: org.membership.exec2!,
          teamRole: 'LEAD',
        }),
      ),
    ).toBe('RULE_VIOLATION');
    expect(
      await code(
        teams.addTeamMember(a.admin!.ctx, { teamId: north, membershipId: org.membership.exec1! }),
      ),
    ).toBe('CONFLICT');
  });

  it('team scope: manager sees led team and its members; executive sees own team; exec2 sees none', async () => {
    expect((await teams.listTeams(a.manager!.ctx)).map((t) => t.name)).toEqual(['North Pune']);
    expect((await teams.listTeams(a.exec1!.ctx)).map((t) => t.name)).toEqual(['North Pune']);
    expect(await teams.listTeams(a.exec2!.ctx)).toEqual([]);
  });

  it('changing team role keeps history (spells)', async () => {
    const spell = await migrator().teamMembership.findFirstOrThrow({
      where: { membershipId: org.membership.manager!, endedAt: null },
    });
    await teams.setTeamRole(a.owner!.ctx, spell.id, 'MEMBER');
    const spells = await migrator().teamMembership.findMany({
      where: { membershipId: org.membership.manager! },
      orderBy: { startedAt: 'asc' },
    });
    expect(spells.map((s) => [s.teamRole, s.endedAt === null])).toEqual([
      ['LEAD', false],
      ['MEMBER', true],
    ]);
  });

  it('archiving ends all open spells', async () => {
    const t = await teams.createTeam(a.owner!.ctx, { name: 'Temporary' });
    await teams.addTeamMember(a.owner!.ctx, { teamId: t.id, membershipId: org.membership.exec2! });
    await teams.archiveTeam(a.owner!.ctx, t.id);
    expect(await migrator().teamMembership.count({ where: { teamId: t.id, endedAt: null } })).toBe(
      0,
    );
  });
});

describe('organisation settings', () => {
  it('everyone reads; Owner/Admin update; invalid time zones are rejected', async () => {
    expect((await getOrgSettings(a.exec1!.ctx)).timeZone).toBe('Asia/Kolkata');
    expect(
      await code(
        updateOrgSettings(a.exec1!.ctx, { name: 'X', timeZone: 'Asia/Kolkata', locale: 'en-IN' }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        updateOrgSettings(a.admin!.ctx, {
          name: 'Teams Realty',
          timeZone: 'Mars/Base',
          locale: 'en-IN',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    await updateOrgSettings(a.admin!.ctx, {
      name: 'Teams Realty LLP',
      timeZone: 'Asia/Kolkata',
      locale: 'en-IN',
    });
    expect((await getOrgSettings(a.owner!.ctx)).name).toBe('Teams Realty LLP');
  });
});

describe('profile', () => {
  it('a user edits only their own profile; phone normalised to E.164', async () => {
    await updateMyProfile(a.exec1!.ctx, { name: 'Exec One', phone: '98765 43210' });
    const p = await getMyProfile(org.users.exec1.id);
    expect(p).toMatchObject({ name: 'Exec One', phoneE164: '+919876543210' });
    expect(await code(updateMyProfile(a.exec1!.ctx, { name: 'Exec One', phone: '123' }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('audit', () => {
  it('Owner/Admin read the org audit log, newest first, with keyset pagination', async () => {
    const first = await listAudit(a.owner!.ctx, { limit: 3 });
    expect(first.rows).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = await listAudit(a.owner!.ctx, { limit: 3, cursor: first.nextCursor! });
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
    expect(ids.size).toBe(first.rows.length + second.rows.length);
    expect(first.rows[0]!.occurredAt >= second.rows[0]!.occurredAt).toBe(true);
    expect(first.rows.some((r) => r.actorName)).toBe(true);
  });

  it('managers, executives and HR cannot read it', async () => {
    for (const k of ['manager', 'exec1', 'hr'])
      expect(await code(listAudit(a[k]!.ctx)), k).toBe('FORBIDDEN');
  });

  it('a garbage cursor is ignored, not an error', async () => {
    expect((await listAudit(a.owner!.ctx, { cursor: 'not-a-cursor' })).rows.length).toBeGreaterThan(
      0,
    );
  });

  it('audit rows are append-only for the app role', async () => {
    const { withRole } = await import('../support/db');
    await withRole(process.env.TEST_DATABASE_URL!, async (c) => {
      await expect(c.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
      await expect(c.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
