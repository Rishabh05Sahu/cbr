// Scope layer (own / team / org) applied in repositories on top of RLS
// (database-design.md §2.6). RLS guards the org boundary; this guards scope.
import type { MembershipRole, Prisma } from '../db/clients';

type Tx = Prisma.TransactionClient;

export type Scope = 'OWN' | 'TEAM' | 'ORG' | 'NONE';

export const LEAD_READ_SCOPE: Record<MembershipRole, Scope> = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: 'TEAM',
  SALES_EXECUTIVE: 'OWN',
  HR_OPS: 'NONE',
};

export async function leadScopeWhere(
  tx: Tx,
  userId: string,
  now: Date,
): Promise<Prisma.LeadWhereInput | null> {
  // RLS limits this lookup to the current org.
  const me = await tx.organizationMembership.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true, roleCode: true },
  });
  if (!me) return null;

  const scope = LEAD_READ_SCOPE[me.roleCode];
  if (scope === 'NONE') return null;
  if (scope === 'ORG') return {};

  // Leave cover: active, unrevoked delegations to me.
  const delegations = await tx.delegation.findMany({
    where: { toUserId: userId, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } },
    select: { fromUserId: true },
  });
  const ownOrDelegated: Prisma.LeadWhereInput[] = [{ ownerUserId: userId }];
  if (delegations.length) {
    ownOrDelegated.push({ ownerUserId: { in: delegations.map((d) => d.fromUserId) } });
  }
  if (scope === 'OWN') return { OR: ownOrDelegated };

  // TEAM: leads queued to, or owned by current members of, teams I currently lead.
  const led = await tx.teamMembership.findMany({
    where: { membershipId: me.id, teamRole: 'LEAD', endedAt: null },
    select: { teamId: true },
  });
  const ledTeamIds = led.map((t) => t.teamId);
  const members = ledTeamIds.length
    ? await tx.teamMembership.findMany({
        where: { teamId: { in: ledTeamIds }, endedAt: null },
        select: { membership: { select: { userId: true } } },
      })
    : [];
  return {
    OR: [
      ...ownOrDelegated,
      { teamId: { in: ledTeamIds } },
      { ownerUserId: { in: members.map((m) => m.membership.userId) } },
    ],
  };
}

export interface LeadListItem {
  id: string;
  orgId: string;
  fullName: string;
  ownerUserId: string | null;
  createdAt: Date;
}

export async function listLeads(
  tx: Tx,
  userId: string,
  opts: { now?: Date; take?: number } = {},
): Promise<LeadListItem[]> {
  const where = await leadScopeWhere(tx, userId, opts.now ?? new Date());
  if (!where) return [];
  return tx.lead.findMany({
    where,
    select: { id: true, orgId: true, fullName: true, ownerUserId: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: opts.take ?? 50,
  });
}
