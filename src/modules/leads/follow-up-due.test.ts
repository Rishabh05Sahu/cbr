// FR-056 "follow-up due" filter (Phase 3 slice 3): parsing, URL round trip, and the day
// boundaries in the org's time zone (IST, and a zone with a daylight-saving change).
import { describe, expect, it } from 'vitest';
import { FOLLOW_UP_DUE, hasFilters, leadQueryString, parseLeadQuery } from './list-query';
import { filterWhere, followUpDueRange } from './list-where';

describe('parseLeadQuery due', () => {
  it('accepts the three approved options and nothing else', () => {
    expect(Object.keys(FOLLOW_UP_DUE)).toEqual(['overdue', 'today', 'next7']);
    for (const due of ['overdue', 'today', 'next7']) {
      const { query, errors } = parseLeadQuery({ due });
      expect(errors).toEqual({});
      expect(query.followUpDue).toBe(due);
      expect(hasFilters(query)).toBe(true);
    }
    for (const due of ['tomorrow', 'OVERDUE', 'none', '7']) {
      const { query, errors } = parseLeadQuery({ due });
      expect(errors).toEqual({ due: 'Unknown follow-up due option' });
      expect(query.followUpDue).toBeNull();
    }
    expect(parseLeadQuery({}).query.followUpDue).toBeNull();
    expect(parseLeadQuery({ due: '' }).errors).toEqual({});
  });

  it('round-trips through the URL with the other filters', () => {
    const { query } = parseLeadQuery({ q: 'Asha', due: 'today', stage: 'CONTACTED' });
    const qs = leadQueryString(query);
    expect(qs).toBe('?q=Asha&stage=CONTACTED&due=today');
    expect(parseLeadQuery(Object.fromEntries(new URLSearchParams(qs))).query).toEqual(query);
  });
});

describe('followUpDueRange (org time zone)', () => {
  // 29 Oct 2026, 01:30 IST (still 28 Oct in UTC).
  const now = new Date('2026-10-28T20:00:00Z');
  const ist = 'Asia/Kolkata';

  it('overdue: strictly before now', () => {
    expect(followUpDueRange('overdue', ist, now)).toEqual({ lt: now });
  });

  it('today: from now to the next local midnight', () => {
    expect(followUpDueRange('today', ist, now)).toEqual({
      gte: now,
      lt: new Date('2026-10-29T18:30:00Z'), // 30 Oct 00:00 IST
    });
  });

  it('next 7 days: the seven local days after today', () => {
    expect(followUpDueRange('next7', ist, now)).toEqual({
      gte: new Date('2026-10-29T18:30:00Z'), // 30 Oct 00:00 IST
      lt: new Date('2026-11-05T18:30:00Z'), //  6 Nov 00:00 IST
    });
  });

  it('uses local midnights across a daylight-saving change', () => {
    // 31 Oct 2026, 12:00 in New York (EDT, UTC−4); clocks go back on 1 Nov.
    const ny = new Date('2026-10-31T16:00:00Z');
    expect(followUpDueRange('today', 'America/New_York', ny)).toEqual({
      gte: ny,
      lt: new Date('2026-11-01T04:00:00Z'), // 1 Nov 00:00 EDT
    });
    expect(followUpDueRange('next7', 'America/New_York', ny)).toEqual({
      gte: new Date('2026-11-01T04:00:00Z'),
      lt: new Date('2026-11-08T05:00:00Z'), // 8 Nov 00:00 EST
    });
  });

  it('is a single condition on next_follow_up_at, composed with the other filters', () => {
    const { query } = parseLeadQuery({ due: 'overdue', stage: 'CONTACTED' });
    expect(filterWhere(query, ist, now)).toEqual([
      { archivedAt: null },
      { stage: { in: ['CONTACTED'] } },
      { nextFollowUpAt: { lt: now } },
    ]);
  });
});
