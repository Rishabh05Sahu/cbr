// FR-105 calendar periods: day / week (Monday first) / month (whole weeks), previous and next,
// date keys and boundaries (month ends, leap years, year ends), the org-local day of an instant,
// and the query fallback.
import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarPeriod,
  dayKeyIn,
  parseCalendarQuery,
  validDayKey,
  weekday,
} from './calendar-rules';

describe('day keys', () => {
  it('accepts real days only', () => {
    expect(validDayKey('2026-10-30')).toBe('2026-10-30');
    expect(validDayKey('2028-02-29')).toBe('2028-02-29');
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '2026-10-32',
      '30-10-2026',
      '',
      undefined,
      '1999-12-31',
    ])
      expect(validDayKey(bad)).toBeNull();
  });
  it('adds days across months and years; Monday is 0', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(weekday('2026-11-02')).toBe(0); // Monday
    expect(weekday('2026-11-08')).toBe(6); // Sunday
  });
  it('reads the org-local day of an instant', () => {
    // 19:00 UTC on 31 Dec is 00:30 on 1 Jan in India.
    expect(dayKeyIn(new Date('2026-12-31T19:00:00Z'), 'Asia/Kolkata')).toBe('2027-01-01');
    expect(dayKeyIn(new Date('2026-12-31T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-12-31');
  });
});

describe('calendarPeriod', () => {
  it('day: one day, steps by one', () => {
    const p = calendarPeriod('day', '2026-10-31');
    expect(p.days).toEqual(['2026-10-31']);
    expect([p.first, p.end, p.prev, p.next]).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-10-30',
      '2026-11-01',
    ]);
  });

  it('week: Monday to Sunday around the date, steps by seven', () => {
    const p = calendarPeriod('week', '2026-11-01'); // a Sunday
    expect(p.days[0]).toBe('2026-10-26');
    expect(p.days[6]).toBe('2026-11-01');
    expect(p.end).toBe('2026-11-02');
    expect([p.prev, p.next]).toEqual(['2026-10-25', '2026-11-08']);
    // Across the year end.
    expect(calendarPeriod('week', '2027-01-01').days).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
  });

  it('month: whole weeks, days of other months marked outside, steps by month', () => {
    const p = calendarPeriod('month', '2026-02-14');
    // February 2026 starts on a Sunday and ends on a Saturday.
    expect(p.first).toBe('2026-01-26');
    expect(p.days.at(-1)).toBe('2026-03-01');
    expect(p.days.length % 7).toBe(0);
    expect(p.outside.has('2026-01-31')).toBe(true);
    expect(p.outside.has('2026-02-01')).toBe(false);
    expect(p.outside.has('2026-03-01')).toBe(true);
    expect([p.prev, p.next]).toEqual(['2026-01-14', '2026-03-14']);
    // The 31st steps to the last day of a shorter month.
    expect(calendarPeriod('month', '2026-01-31').next).toBe('2026-02-28');
    expect(calendarPeriod('month', '2028-03-31').prev).toBe('2028-02-29');
  });
});

describe('parseCalendarQuery', () => {
  it('falls back to this week for anything invalid', () => {
    expect(parseCalendarQuery(undefined, undefined, '2026-10-30')).toEqual({
      view: 'week',
      date: '2026-10-30',
    });
    expect(parseCalendarQuery('year', '2026-02-30', '2026-10-30')).toEqual({
      view: 'week',
      date: '2026-10-30',
    });
    expect(parseCalendarQuery('month', '2026-12-05', '2026-10-30')).toEqual({
      view: 'month',
      date: '2026-12-05',
    });
  });
});
