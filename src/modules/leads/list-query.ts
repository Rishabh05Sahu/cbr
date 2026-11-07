// Leads module: lead-list query parsing and cursors (FR-056, Phase 2 M2). Pure functions: URL
// search params in, a validated query out. Nothing here touches the database; ./index.ts turns
// the query into a scope-filtered Prisma `where` (values are bound parameters, never SQL text).
import { parseBudgetInr } from './normalise';
import { LEAD_STAGES, parseOrgLocal, type LeadStage } from './stages';

export const LEAD_SORTS = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name (A–Z)',
} as const;
export type LeadSort = keyof typeof LEAD_SORTS;

export const LEAD_PAGE_SIZE = 25;

/**
 * FR-056 "follow-up due" (Phase 3 slice 3; options approved by the owner, using FR-101's My Day
 * vocabulary). A lead is classified by its next open follow-up (lead.next_follow_up_at, FR-108);
 * leads without one never match. Days are calendar days in the org's time zone.
 *   overdue  due before now (strict: no grace, like the lead page's Overdue badge)
 *   today    from now until the start of tomorrow
 *   next7    from the start of tomorrow until the start of the 8th day (the 7 days after today)
 */
export const FOLLOW_UP_DUE = {
  overdue: 'Overdue',
  today: 'Due today',
  next7: 'Next 7 days',
} as const;
export type FollowUpDue = keyof typeof FOLLOW_UP_DUE;

const INTENT_CODES = ['HOT', 'WARM', 'COLD'] as const;
const PROPERTY_CODES = [
  'APARTMENT',
  'VILLA',
  'PLOT',
  'ROW_HOUSE',
  'OFFICE',
  'SHOP',
  'WAREHOUSE',
  'OTHER',
] as const;

export interface LeadQuery {
  q: string | null;
  stages: LeadStage[];
  intents: string[];
  propertyTypes: string[];
  /** A member's user id, or 'none' for unassigned leads. */
  owner: string | null;
  teamId: string | null;
  sourceId: string | null;
  city: string | null;
  /** "YYYY-MM-DD", inclusive, read in the org's time zone. */
  createdFrom: string | null;
  createdTo: string | null;
  /**
   * Assigned date (M3): the day the lead's current owner got it, i.e. the start of its open
   * assignment spell with an owner. Same format and time zone as the created dates.
   */
  assignedFrom: string | null;
  assignedTo: string | null;
  /** Decimal rupee strings from the M0 budget parser. */
  budgetFrom: string | null;
  budgetTo: string | null;
  /** Phase 3 (FR-056): the next open follow-up's due bucket; see FOLLOW_UP_DUE. */
  followUpDue: FollowUpDue | null;
  /** M5 (FR-061): archived leads are hidden unless asked for. Merged tombstones never list. */
  archived: LeadArchiveView;
  sort: LeadSort;
  cursor: string | null;
}

export const ARCHIVE_VIEWS = ['active', 'archived', 'all'] as const;
export type LeadArchiveView = (typeof ARCHIVE_VIEWS)[number];

export type SearchParams = Record<string, string | string[] | undefined>;

export interface ParsedLeadQuery {
  query: LeadQuery;
  /** Parameter → message. When non-empty the list is not run (a filter is never dropped silently). */
  errors: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const first = (v: string | string[] | undefined): string => {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.trim() : '';
};
const all = (v: string | string[] | undefined): string[] =>
  (Array.isArray(v) ? v : v === undefined ? [] : [v]).map((s) => s.trim()).filter(Boolean);

function codes<T extends string>(
  sp: SearchParams,
  key: string,
  allowed: readonly T[],
  errors: Record<string, string>,
  what: string,
): T[] {
  const values = [...new Set(all(sp[key]))];
  if (values.length > allowed.length || values.some((v) => !allowed.includes(v as T))) {
    errors[key] = `Unknown ${what}`;
    return [];
  }
  return values as T[];
}

/**
 * Validates every supported parameter. Unknown parameter names are ignored (they never reach the
 * query); a known parameter with a bad value is reported. Values are bounded in length.
 */
export function parseLeadQuery(sp: SearchParams): ParsedLeadQuery {
  const errors: Record<string, string> = {};

  let q: string | null = first(sp.q).replace(/\s+/g, ' ');
  if (!q) q = null;
  else if (q.length < 2 || q.length > 100) {
    errors.q = 'Search for 2 to 100 characters';
    q = null;
  }

  const id = (key: string, what: string, allowNone = false): string | null => {
    const v = first(sp[key]);
    if (!v) return null;
    if (allowNone && v === 'none') return v;
    if (!UUID.test(v)) {
      errors[key] = `Unknown ${what}`;
      return null;
    }
    return v.toLowerCase();
  };

  const city = first(sp.city);
  if (city.length > 100) errors.city = 'City is too long';

  const date = (key: string): string | null => {
    const v = first(sp[key]);
    if (!v) return null;
    if (!DATE.test(v) || !parseOrgLocal(v, 'UTC')) {
      errors[key] = 'Enter a valid date';
      return null;
    }
    return v;
  };
  const createdFrom = date('createdFrom');
  const createdTo = date('createdTo');
  if (createdFrom && createdTo && createdFrom > createdTo)
    errors.createdTo = 'The end date is before the start date';
  const assignedFrom = date('assignedFrom');
  const assignedTo = date('assignedTo');
  if (assignedFrom && assignedTo && assignedFrom > assignedTo)
    errors.assignedTo = 'The end date is before the start date';

  const budget = (key: string): string | null => {
    const r = parseBudgetInr(first(sp[key]).slice(0, 41));
    if (!r.ok) {
      errors[key] = r.message;
      return null;
    }
    return r.value;
  };
  const budgetFrom = budget('budgetFrom');
  const budgetTo = budget('budgetTo');
  if (budgetFrom && budgetTo && Number(budgetFrom) > Number(budgetTo))
    errors.budgetTo = 'Maximum budget must not be below the minimum';

  const dueRaw = first(sp.due);
  const followUpDue = Object.hasOwn(FOLLOW_UP_DUE, dueRaw) ? (dueRaw as FollowUpDue) : null;
  if (dueRaw && !followUpDue) errors.due = 'Unknown follow-up due option';

  const archivedRaw = first(sp.archived) || 'active';
  const archived: LeadArchiveView = (ARCHIVE_VIEWS as readonly string[]).includes(archivedRaw)
    ? (archivedRaw as LeadArchiveView)
    : 'active';
  if (archived !== archivedRaw) errors.archived = 'Unknown archive view';

  const sortRaw = first(sp.sort) || 'newest';
  const sort: LeadSort = Object.hasOwn(LEAD_SORTS, sortRaw) ? (sortRaw as LeadSort) : 'newest';
  if (sort !== sortRaw) errors.sort = 'Unknown sort order';

  const cursor = first(sp.cursor) || null;
  if (cursor && !decodeLeadCursor(cursor, sort))
    errors.cursor = 'This page link is no longer valid';

  return {
    query: {
      q,
      stages: codes(sp, 'stage', LEAD_STAGES, errors, 'stage'),
      intents: codes(sp, 'intent', INTENT_CODES, errors, 'intent'),
      propertyTypes: codes(sp, 'propertyType', PROPERTY_CODES, errors, 'property type'),
      owner: id('owner', 'owner', true),
      teamId: id('team', 'team'),
      sourceId: id('source', 'source'),
      city: city && city.length <= 100 ? city : null,
      createdFrom,
      createdTo,
      assignedFrom,
      assignedTo,
      budgetFrom,
      budgetTo,
      followUpDue,
      archived,
      sort,
      cursor: errors.cursor ? null : cursor,
    },
    errors,
  };
}

// ---------------------------------------------------------------------------------------------
// Cursors: opaque base64url JSON of the last row's sort key. A cursor only says where to resume;
// the caller's scope and filters are applied again on every page, so a forged cursor can change
// the starting point but never what is visible.

export interface LeadCursor {
  s: LeadSort;
  id: string;
  /** Sort value for sorts other than id order (the lead's full name for 'name'). */
  k?: string;
}

export function encodeLeadCursor(sort: LeadSort, row: { id: string; fullName: string }): string {
  const c: LeadCursor =
    sort === 'name' ? { s: sort, id: row.id, k: row.fullName } : { s: sort, id: row.id };
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

/** Null for anything malformed, too long, or made for another sort order. */
export function decodeLeadCursor(raw: string, sort: LeadSort): LeadCursor | null {
  if (raw.length > 600 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!c || typeof c !== 'object') return null;
    const { s, id, k } = c as Record<string, unknown>;
    if (s !== sort || typeof id !== 'string' || !UUID.test(id)) return null;
    if (sort === 'name') {
      if (typeof k !== 'string' || k.length < 1 || k.length > 200) return null;
      return { s: sort, id: id.toLowerCase(), k };
    }
    return { s: sort, id: id.toLowerCase() };
  } catch {
    return null;
  }
}

/** Search text that looks like a phone fragment: its digits (4–15), else null. */
export function phoneDigits(q: string): string | null {
  if (!/^[\d\s()+.-]+$/.test(q)) return null;
  const d = q.replace(/\D/g, '');
  return d.length >= 4 && d.length <= 15 ? d : null;
}

/** URL search string for a query, e.g. to link the next page. Defaults are omitted. */
export function leadQueryString(query: LeadQuery, cursor: string | null = null): string {
  const p = new URLSearchParams();
  if (query.q) p.set('q', query.q);
  for (const s of query.stages) p.append('stage', s);
  for (const s of query.intents) p.append('intent', s);
  for (const s of query.propertyTypes) p.append('propertyType', s);
  if (query.owner) p.set('owner', query.owner);
  if (query.teamId) p.set('team', query.teamId);
  if (query.sourceId) p.set('source', query.sourceId);
  if (query.city) p.set('city', query.city);
  if (query.createdFrom) p.set('createdFrom', query.createdFrom);
  if (query.createdTo) p.set('createdTo', query.createdTo);
  if (query.assignedFrom) p.set('assignedFrom', query.assignedFrom);
  if (query.assignedTo) p.set('assignedTo', query.assignedTo);
  if (query.budgetFrom) p.set('budgetFrom', query.budgetFrom);
  if (query.budgetTo) p.set('budgetTo', query.budgetTo);
  if (query.followUpDue) p.set('due', query.followUpDue);
  if (query.archived !== 'active') p.set('archived', query.archived);
  if (query.sort !== 'newest') p.set('sort', query.sort);
  if (cursor) p.set('cursor', cursor);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function hasFilters(query: LeadQuery): boolean {
  return leadQueryString({ ...query, sort: 'newest' }) !== '';
}
