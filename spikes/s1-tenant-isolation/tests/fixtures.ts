// Synthetic fixtures for S1. Seeded as crm_migrator (maintenance policy), never as crm_app.
import { randomUUID } from 'node:crypto';
import type { ClientHandle } from '../db/clients';

export interface OrgFixture {
  orgId: string;
  name: string;
  users: {
    owner: string;
    admin: string;
    manager: string;
    exec1: string;
    exec2: string;
    exec3: string;
    hr: string;
  };
  teams: { north: string; south: string };
  /** Lead ids keyed by label. */
  leads: Record<string, string>;
  importJobId: string;
  connectionTokenHash: string;
  shareTokenHash: string;
  invitationTokenHash: string;
}

const tag = () => randomUUID().slice(0, 8);

/**
 * Per org: owner, admin, manager (leads North, member of South), exec1 + exec2 in North,
 * exec3 in South, an HR user. exec2 has an active delegation from exec3; exec1 has an
 * expired one from exec3. Lead "reassigned" moved from exec1 to exec2.
 */
export async function seedOrg(m: ClientHandle, name: string): Promise<OrgFixture> {
  const db = m.prisma;
  const t = tag();
  const org = await db.organization.create({ data: { name: `${name} ${t}` } });
  const orgId = org.id;

  const mkUser = async (label: string) =>
    (
      await db.user.create({
        data: { email: `${label}.${t}@${name.toLowerCase()}.test`, name: `${name} ${label}` },
      })
    ).id;
  const users = {
    owner: await mkUser('owner'),
    admin: await mkUser('admin'),
    manager: await mkUser('manager'),
    exec1: await mkUser('exec1'),
    exec2: await mkUser('exec2'),
    exec3: await mkUser('exec3'),
    hr: await mkUser('hr'),
  };
  const roles = {
    owner: 'OWNER',
    admin: 'ADMIN',
    manager: 'SALES_MANAGER',
    exec1: 'SALES_EXECUTIVE',
    exec2: 'SALES_EXECUTIVE',
    exec3: 'SALES_EXECUTIVE',
    hr: 'HR_OPS',
  } as const;
  const membership: Record<string, string> = {};
  for (const [k, userId] of Object.entries(users)) {
    const mem = await db.organizationMembership.create({
      data: { orgId, userId, roleCode: roles[k as keyof typeof roles] },
    });
    membership[k] = mem.id;
  }

  const north = (await db.team.create({ data: { orgId, name: 'North' } })).id;
  const south = (await db.team.create({ data: { orgId, name: 'South' } })).id;
  const tm = (teamId: string, who: string, teamRole: 'MEMBER' | 'LEAD' = 'MEMBER') =>
    db.teamMembership.create({ data: { orgId, teamId, membershipId: membership[who]!, teamRole } });
  await tm(north, 'manager', 'LEAD');
  await tm(south, 'manager', 'MEMBER'); // overlapping membership, but not lead of South
  await tm(north, 'exec1');
  await tm(north, 'exec2');
  await tm(south, 'exec3');

  const leads: Record<string, string> = {};
  const mkLead = async (label: string, ownerUserId: string | null, teamId: string | null) => {
    const lead = await db.lead.create({
      data: {
        orgId,
        fullName: `${name} lead ${label}`,
        phoneE164: `+9198${Math.floor(1e7 + Math.random() * 9e7)}`,
        ownerUserId,
        teamId,
      },
    });
    leads[label] = lead.id;
    return lead.id;
  };
  await mkLead('exec1', users.exec1, north);
  await mkLead('exec2', users.exec2, north);
  await mkLead('exec3', users.exec3, south);
  await mkLead('unassignedNorth', null, north);
  await mkLead('unassignedSouth', null, south);
  await mkLead('admin', users.admin, null);

  // Reassigned lead: exec1 -> exec2, with closed and open spells.
  const reassigned = await mkLead('reassigned', users.exec2, north);
  const t0 = new Date(Date.now() - 10 * 86_400_000);
  const t1 = new Date(Date.now() - 5 * 86_400_000);
  await db.leadAssignmentHistory.create({
    data: {
      orgId,
      leadId: reassigned,
      userId: users.exec1,
      startedAt: t0,
      endedAt: t1,
      source: 'MANUAL',
    },
  });
  await db.leadAssignmentHistory.create({
    data: { orgId, leadId: reassigned, userId: users.exec2, startedAt: t1, source: 'MANUAL' },
  });

  const now = Date.now();
  await db.delegation.create({
    data: {
      orgId,
      fromUserId: users.exec3,
      toUserId: users.exec2,
      startsAt: new Date(now - 86_400_000),
      endsAt: new Date(now + 86_400_000),
    },
  });
  await db.delegation.create({
    data: {
      orgId,
      fromUserId: users.exec3,
      toUserId: users.exec1,
      startsAt: new Date(now - 10 * 86_400_000),
      endsAt: new Date(now - 86_400_000),
    },
  });

  await db.task.create({
    data: {
      orgId,
      leadId: leads.exec1!,
      assigneeUserId: users.exec1,
      title: 'Call back',
      dueAt: new Date(now + 3_600_000),
    },
  });
  await db.interaction.create({
    data: { orgId, leadId: leads.exec1!, userId: users.exec1, outcome: 'CONNECTED' },
  });
  const job = await db.importJob.create({ data: { orgId, fileName: 'leads.csv', status: 'DONE' } });
  await db.importRow.create({
    data: { orgId, importJobId: job.id, rowNumber: 1, data: { name: 'x' } },
  });

  const connectionTokenHash = `wh_${t}_${randomUUID()}`;
  const shareTokenHash = `sh_${t}_${randomUUID()}`;
  const invitationTokenHash = `inv_${t}_${randomUUID()}`;
  await db.integrationConnection.create({
    data: {
      orgId,
      provider: 'exotel',
      webhookTokenHash: connectionTokenHash,
      secretCiphertext: 'enc:secret',
    },
  });
  await db.shareLink.create({
    data: { orgId, tokenHash: shareTokenHash, expiresAt: new Date(now + 86_400_000) },
  });
  await db.invitation.create({
    data: {
      orgId,
      email: `invitee.${t}@example.test`,
      roleCode: 'SALES_EXECUTIVE',
      tokenHash: invitationTokenHash,
      status: 'PENDING',
      expiresAt: new Date(now + 7 * 86_400_000),
    },
  });
  await db.auditLog.create({
    data: { orgId, action: 'org.created', entityType: 'organization', entityId: orgId },
  });

  return {
    orgId,
    name,
    users,
    teams: { north, south },
    leads,
    importJobId: job.id,
    connectionTokenHash,
    shareTokenHash,
    invitationTokenHash,
  };
}

/** Tables with org_id that the representative suite exercises (Prisma delegate names). */
export const TENANT_DELEGATES = [
  'organizationMembership',
  'team',
  'teamMembership',
  'lead',
  'leadAssignmentHistory',
  'delegation',
  'task',
  'interaction',
  'importJob',
  'importRow',
  'integrationConnection',
  'shareLink',
  'invitation',
  'auditLog',
] as const;

/** Same tables by SQL name, for raw-SQL checks. */
export const TENANT_TABLES = [
  'organization_membership',
  'team',
  'team_membership',
  'lead',
  'lead_assignment_history',
  'delegation',
  'task',
  'interaction',
  'import_job',
  'import_row',
  'integration_connection',
  'share_link',
  'invitation',
  'audit_log',
] as const;
