// FR-056 lead filters as a Prisma `where` (shared by the lead list and the M5 export job, so an
// export contains exactly what the Owner filtered). Every value is a bound parameter.
import type { Prisma } from '@/platform/db';
import { phoneDigits, type FollowUpDue, type LeadQuery } from './list-query';
import { normaliseIndianPhone } from './normalise';
import { parseOrgLocal } from './stages';

/** Inclusive "YYYY-MM-DD" end date → the next day's date string. */
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** The calendar date ("YYYY-MM-DD") of an instant in a time zone. */
function dateIn(at: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * FR-056 "follow-up due" (see FOLLOW_UP_DUE) as a range on lead.next_follow_up_at, the earliest
 * open follow-up maintained by the database (null = none, which never matches). Day boundaries
 * are local midnights in the org's time zone; `now` is the request time.
 */
export function followUpDueRange(
  due: FollowUpDue,
  timeZone: string,
  now: Date,
): Prisma.DateTimeNullableFilter {
  if (due === 'overdue') return { lt: now };
  let day = nextDay(dateIn(now, timeZone));
  const tomorrow = parseOrgLocal(day, timeZone)!;
  if (due === 'today') return { gte: now, lt: tomorrow };
  for (let i = 0; i < 7; i++) day = nextDay(day);
  return { gte: tomorrow, lt: parseOrgLocal(day, timeZone)! };
}

/** FR-056 filters and search as a Prisma `where`. Every value is a bound parameter. */
export function filterWhere(
  q: LeadQuery,
  timeZone: string,
  now: Date = new Date(),
): Prisma.LeadWhereInput[] {
  const and: Prisma.LeadWhereInput[] = [];
  if (q.archived === 'active') and.push({ archivedAt: null });
  else if (q.archived === 'archived') and.push({ archivedAt: { not: null } });
  if (q.q) {
    const digits = phoneDigits(q.q);
    const full = digits ? normaliseIndianPhone(q.q) : null;
    if (full?.ok && full.value) {
      // M6 P-C: a complete mobile number in any accepted format (M0 normaliser) matches that
      // number exactly, as either phone, and nothing else. phone_last10 is always the primary's
      // last 10 digits, and text equality is LEAKPROOF, so the (org_id, phone_last10) and
      // (org_id, alternate_phone_e164) indexes serve this under RLS; the substring search below
      // reads the whole table. Unlike the substring search, a name or e-mail that merely
      // contains the digits is not a match.
      const e164 = full.value.e164;
      and.push({
        OR: [
          { phoneLast10: e164.slice(-10), primaryPhoneE164: e164 },
          { alternatePhoneE164: e164 },
        ],
      });
    } else {
      // Prisma passes `contains` to ILIKE without escaping, so LIKE metacharacters are escaped
      // here: "%" and "_" in search text match themselves, not "anything".
      const literal = q.q.replace(/[\\%_]/g, (c) => `\\${c}`);
      const or: Prisma.LeadWhereInput[] = [
        { fullName: { contains: literal, mode: 'insensitive' } },
        { email: { contains: literal, mode: 'insensitive' } },
      ];
      // Phone fragments: the digits match anywhere in either phone.
      if (digits)
        or.push(
          { primaryPhoneE164: { contains: digits } },
          { alternatePhoneE164: { contains: digits } },
        );
      and.push({ OR: or });
    }
  }
  if (q.stages.length) and.push({ stage: { in: q.stages } });
  if (q.intents.length) and.push({ intent: { in: q.intents } });
  if (q.propertyTypes.length) and.push({ propertyType: { in: q.propertyTypes } });
  if (q.owner) and.push({ ownerUserId: q.owner === 'none' ? null : q.owner });
  if (q.teamId) and.push({ teamId: q.teamId });
  if (q.sourceId) and.push({ sourceId: q.sourceId });
  if (q.city) and.push({ preferredCity: { equals: q.city, mode: 'insensitive' } });
  if (q.createdFrom) and.push({ createdAt: { gte: parseOrgLocal(q.createdFrom, timeZone)! } });
  if (q.createdTo) and.push({ createdAt: { lt: parseOrgLocal(nextDay(q.createdTo), timeZone)! } });
  if (q.assignedFrom || q.assignedTo)
    and.push({
      assignments: {
        some: {
          endedAt: null,
          userId: { not: null },
          startedAt: {
            ...(q.assignedFrom ? { gte: parseOrgLocal(q.assignedFrom, timeZone)! } : {}),
            ...(q.assignedTo ? { lt: parseOrgLocal(nextDay(q.assignedTo), timeZone)! } : {}),
          },
        },
      },
    });
  if (q.followUpDue) and.push({ nextFollowUpAt: followUpDueRange(q.followUpDue, timeZone, now) });
  // Budget: the lead's range [min, max] (a missing end equals the other) overlaps the filter.
  if (q.budgetFrom)
    and.push({
      OR: [
        { budgetMax: { gte: q.budgetFrom } },
        { budgetMax: null, budgetMin: { gte: q.budgetFrom } },
      ],
    });
  if (q.budgetTo)
    and.push({
      OR: [{ budgetMin: { lte: q.budgetTo } }, { budgetMin: null, budgetMax: { lte: q.budgetTo } }],
    });
  return and;
}
