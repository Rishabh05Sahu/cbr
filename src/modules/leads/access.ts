// Leads module internals shared by its commands (not part of the public API): visibility scope
// (user-personas-and-roles §2.2), id/version/text helpers and per-phone locking.
import { z } from 'zod';
import { ledTeamIds } from '@/modules/teams';
import type { RequestContext, Scope } from '@/platform/authz';
import type { Prisma, Tx } from '@/platform/db';
import { conflict, DomainError, notFound, ruleViolation } from '@/platform/errors';
import { MERGE_CHAIN_MAX, MergeChainBroken, timelineLeadIds } from './merge-plan';

export const OPEN: Prisma.LeadWhereInput = {
  stage: { notIn: ['WON', 'LOST'] },
  deletedAt: null,
  mergedIntoLeadId: null,
};

export function invalid(fieldErrors: Record<string, string[]>): DomainError {
  return new DomainError('VALIDATION_FAILED', 'Please check the highlighted fields', fieldErrors);
}

/** Plain text only: control characters other than newline/tab are removed. */
export function cleanText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

export function parseId(id: unknown, what = 'Lead'): string {
  const r = z.uuid().safeParse(id);
  if (!r.success) throw notFound(`${what} not found`);
  return r.data;
}

// Scope (user-personas-and-roles §2.2). Delegations and visit assignees arrive in Phase 4.

export async function scopeFilter(
  tx: Tx,
  ctx: RequestContext,
  scope: Scope,
): Promise<Prisma.LeadWhereInput> {
  const base: Prisma.LeadWhereInput = { deletedAt: null };
  if (scope === 'ORG') return base;
  if (ctx.kind !== 'member') return { id: { in: [] } };
  if (scope === 'OWN') return { ...base, ownerUserId: ctx.userId };
  const led = await ledTeamIds(tx, ctx.membershipId);
  if (!led.length) return { ...base, ownerUserId: ctx.userId };
  const members = await tx.teamMembership.findMany({
    where: { teamId: { in: led }, endedAt: null },
    select: { membership: { select: { userId: true } } },
  });
  return {
    ...base,
    OR: [
      { ownerUserId: ctx.userId },
      { teamId: { in: led } },
      { ownerUserId: { in: [...new Set(members.map((m) => m.membership.userId))] } },
    ],
  };
}

export async function findInScope<S extends Prisma.LeadSelect>(
  tx: Tx,
  ctx: RequestContext,
  scope: Scope,
  id: string,
  select: S,
) {
  const lead = await tx.lead.findFirst({
    where: { AND: [{ id }, await scopeFilter(tx, ctx, scope)] },
    select,
  });
  if (!lead) throw notFound('Lead not found');
  return lead;
}

/**
 * Merge by reference (D1): a merged lead's id stands for its surviving lead. Commands that add a
 * note or an enquiry to a lead by id write to this lead instead, so nothing new lands on a
 * tombstone. Application-level only: the database freezes the merged lead's own row
 * (lead_hygiene_guard) but does not refuse note or enquiry rows that name it. RLS limits the
 * walk to the session org; an unknown id is returned unchanged (the caller's scope check 404s).
 * Each step takes FOR KEY SHARE on the row: a merge in progress holds FOR UPDATE on both leads,
 * so the caller waits for it and then reads the committed pointer (no write lands on a lead that
 * becomes a tombstone in a concurrent transaction). Ordinary edits do not block it.
 */
export async function canonicalLeadId(tx: Tx, id: string): Promise<string> {
  const seen = new Set([id]);
  let at = id;
  for (let i = 0; i < MERGE_CHAIN_MAX; i++) {
    const [row] = await tx.$queryRaw<{ merged_into_lead_id: string | null }[]>`
      SELECT merged_into_lead_id FROM lead WHERE id = ${at}::uuid FOR KEY SHARE`;
    const next = row?.merged_into_lead_id ?? null;
    if (next === null) return at;
    if (seen.has(next)) throw new MergeChainBroken(`merge chain cycle at ${next}`);
    seen.add(next);
    at = next;
  }
  throw new MergeChainBroken(`merge chain longer than ${MERGE_CHAIN_MAX}`);
}

/**
 * The leads whose history forms `leadId`'s combined timeline (D1): itself and every tombstone
 * whose merge chain ends at it, at most MERGE_CHAIN_MAX levels deep (RLS: session org only).
 */
export async function historyLeadIds(tx: Tx, leadId: string): Promise<string[]> {
  const tombstones: { id: string; mergedIntoLeadId: string }[] = [];
  let level = [leadId];
  for (let depth = 0; depth < MERGE_CHAIN_MAX && level.length; depth++) {
    const rows = await tx.lead.findMany({
      where: { mergedIntoLeadId: { in: level } },
      select: { id: true, mergedIntoLeadId: true },
    });
    for (const r of rows) tombstones.push({ id: r.id, mergedIntoLeadId: r.mergedIntoLeadId! });
    level = rows.map((r) => r.id);
  }
  return timelineLeadIds(leadId, tombstones);
}

/** Columns assertWritable needs. */
export const WRITABLE_FIELDS = { archivedAt: true, mergedIntoLeadId: true } as const;

/**
 * M5: a merged lead is a tombstone (the database also refuses any update to it) and an archived
 * lead is read-only until an Owner/Admin restores it (FR-061; application rule). Enquiries for an
 * archived lead are the one exception: they are attached and routed to duplicate review (D2).
 */
export function assertWritable(lead: { archivedAt: Date | null; mergedIntoLeadId: string | null }) {
  if (lead.mergedIntoLeadId) throw ruleViolation('This lead was merged into another lead');
  if (lead.archivedAt) throw ruleViolation('This lead is archived. Restore it before changing it');
}

export function isOpenPhoneConflict(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (
    /lead_open_phone_uq/.test(e.message) ||
    (/unique constraint/i.test(e.message) && /primary_phone_e164/.test(e.message))
  );
}

/** Serialises creates/reopens per (org, phone) so the duplicate check cannot race. */
export async function lockPhones(tx: Tx, orgId: string, phones: string[]): Promise<void> {
  for (const p of [...new Set(phones)].sort())
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `lead-phone:${orgId}:${p}`,
    );
}

/**
 * Oldest open lead whose primary or alternate phone matches (lead-lifecycle §5.1).
 *
 * Same predicate and order as the OPEN filter with Prisma's findFirst (M6 P-F), written as SQL
 * so the stage list is a literal. Prisma binds it as `CAST($n::text AS lead_stage)`, which is not
 * folded at plan time, so the planner could not prove the partial unique index
 * `lead_open_phone_uq` (same OPEN predicate) applies and read every open lead of the org. With
 * literals, that index serves the primary branch and (org_id, alternate_phone_e164) the
 * alternate one. The tenant comes from RLS, as before; text equality is LEAKPROOF.
 */
export async function findOpenMatch(
  tx: Tx,
  phones: string[],
): Promise<{ id: string; archivedAt: Date | null } | null> {
  if (phones.length === 0) return null;
  const rows = await tx.$queryRaw<{ id: string; archived_at: Date | null }[]>`
    SELECT id, archived_at FROM lead
     WHERE stage NOT IN ('WON', 'LOST') AND deleted_at IS NULL AND merged_into_lead_id IS NULL
       AND (primary_phone_e164 = ANY(${phones}::text[])
            OR alternate_phone_e164 = ANY(${phones}::text[]))
     ORDER BY created_at ASC
     LIMIT 1`;
  const row = rows[0];
  return row ? { id: row.id, archivedAt: row.archived_at } : null;
}

export async function ensureUnknownSource(tx: Tx, orgId: string): Promise<string> {
  await tx.$executeRawUnsafe(
    `INSERT INTO lead_source (org_id, name, channel) VALUES ($1::uuid, 'Unknown', 'OTHER')
     ON CONFLICT (org_id, lower(name)) DO NOTHING`,
    orgId,
  );
  const row = await tx.leadSource.findFirstOrThrow({
    where: { name: { equals: 'Unknown', mode: 'insensitive' } },
    select: { id: true },
  });
  return row.id;
}

/** The creator's team for a new lead (domain-model: the owner's primary team). */
export async function primaryTeamId(tx: Tx, membershipId: string): Promise<string | null> {
  const spell = await tx.teamMembership.findFirst({
    where: { membershipId, endedAt: null, team: { archivedAt: null } },
    orderBy: { startedAt: 'asc' },
    select: { teamId: true },
  });
  return spell?.teamId ?? null;
}

export function staleVersion(): DomainError {
  return conflict('This lead was changed by someone else. Reload the page and try again.');
}
