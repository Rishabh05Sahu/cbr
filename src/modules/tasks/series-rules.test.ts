// FR-107 recurrence (ADR-0020): the next occurrence strictly after a moment, daily and weekly, in
// the org's time zone (India; Europe/London for daylight saving), across month and year ends, with
// an inclusive end date and skipped missed dates; and the summary text.
import { describe, expect, it } from 'vitest';
import { parseOrgLocal } from '@/modules/leads';
import { describeSeries, nextOccurrence, validLocalTime, type SeriesRule } from './series-rules';

const next = (rule: Partial<SeriesRule>, after: string, tz = 'Asia/Kolkata') =>
  nextOccurrence(
    { frequency: 'DAILY', weekday: null, localTime: '09:00', endDate: null, ...rule },
    new Date(after),
    tz,
    (v) => parseOrgLocal(v, tz),
  )?.toISOString() ?? null;

describe('daily', () => {
  it('is the same day when the time is still ahead, otherwise the next day (India time)', () => {
    // 08:00 IST = 02:30Z → today 09:00 IST = 03:30Z.
    expect(next({}, '2026-11-02T02:30:00Z')).toBe('2026-11-02T03:30:00.000Z');
    // Exactly 09:00 IST is not strictly after: tomorrow.
    expect(next({}, '2026-11-02T03:30:00Z')).toBe('2026-11-03T03:30:00.000Z');
    // 01:00 IST on 3 Nov is still 2 Nov in UTC: the local day matters.
    expect(next({}, '2026-11-02T19:30:00Z')).toBe('2026-11-03T03:30:00.000Z');
  });
  it('crosses month and year ends, and skips missed days (strictly after now)', () => {
    expect(next({}, '2026-11-30T06:00:00Z')).toBe('2026-12-01T03:30:00.000Z');
    expect(next({}, '2026-12-31T06:00:00Z')).toBe('2027-01-01T03:30:00.000Z');
    expect(next({ localTime: '23:45' }, '2028-02-28T18:20:00Z')).toBe('2028-02-29T18:15:00.000Z');
  });
  it('stops after the inclusive end date', () => {
    expect(next({ endDate: '2026-11-02' }, '2026-11-02T02:30:00Z')).toBe(
      '2026-11-02T03:30:00.000Z',
    );
    expect(next({ endDate: '2026-11-02' }, '2026-11-02T04:00:00Z')).toBeNull();
  });
});

describe('weekly', () => {
  it('is the next chosen weekday at the time', () => {
    // Monday 2 Nov 2026; weekday 4 = Friday.
    expect(next({ frequency: 'WEEKLY', weekday: 4 }, '2026-11-02T06:00:00Z')).toBe(
      '2026-11-06T03:30:00.000Z',
    );
    // On the day before the time: that day; after it: a week later.
    expect(next({ frequency: 'WEEKLY', weekday: 0 }, '2026-11-02T02:00:00Z')).toBe(
      '2026-11-02T03:30:00.000Z',
    );
    expect(next({ frequency: 'WEEKLY', weekday: 0 }, '2026-11-02T04:00:00Z')).toBe(
      '2026-11-09T03:30:00.000Z',
    );
    // Sunday across the year end.
    expect(next({ frequency: 'WEEKLY', weekday: 6 }, '2026-12-28T06:00:00Z')).toBe(
      '2027-01-03T03:30:00.000Z',
    );
  });
  it('respects the end date (a week past it is none)', () => {
    expect(
      next({ frequency: 'WEEKLY', weekday: 4, endDate: '2026-11-05' }, '2026-11-02T06:00:00Z'),
    ).toBeNull();
  });
});

describe('daylight saving (Europe/London)', () => {
  it('keeps the local wall-clock time across the change', () => {
    // 09:00 BST = 08:00Z before 25 Oct 2026; 09:00 GMT = 09:00Z after.
    expect(next({}, '2026-10-24T12:00:00Z', 'Europe/London')).toBe('2026-10-25T09:00:00.000Z');
    expect(next({}, '2026-10-23T12:00:00Z', 'Europe/London')).toBe('2026-10-24T08:00:00.000Z');
    expect(next({}, '2027-03-27T12:00:00Z', 'Europe/London')).toBe('2027-03-28T08:00:00.000Z');
  });
});

describe('text and input', () => {
  it('describes the rule', () => {
    expect(
      describeSeries({ frequency: 'DAILY', weekday: null, localTime: '09:00', endDate: null }),
    ).toBe('Daily at 09:00');
    expect(
      describeSeries({
        frequency: 'WEEKLY',
        weekday: 0,
        localTime: '17:30',
        endDate: '2026-11-30',
      }),
    ).toBe('Every Monday at 17:30, until 30 Nov 2026');
  });
  it('accepts HH:MM only', () => {
    expect(validLocalTime('09:00')).toBe(true);
    for (const bad of ['9:00', '24:00', '09:60', '', undefined])
      expect(validLocalTime(bad)).toBe(false);
  });
});
