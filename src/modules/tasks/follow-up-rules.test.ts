// Follow-up rules (FR-102 reschedule reasons, FR-108 next follow-up) and the due-time window.
import { describe, expect, it } from 'vitest';
import {
  compareMyDay,
  dueAtProblem,
  isOverdue,
  MAX_DAYS_AHEAD,
  myDayBucket,
  nextFollowUpAt,
  rescheduleNeedsReason,
} from './follow-up-rules';

const now = new Date('2026-10-28T10:00:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

describe('dueAtProblem', () => {
  it('accepts a future time and the current minute', () => {
    expect(dueAtProblem(at(60), now)).toBeNull();
    expect(dueAtProblem(at(-0.5), now)).toBeNull(); // submitted a moment after the minute
  });
  it('refuses a missing or past time', () => {
    expect(dueAtProblem(null, now)).toBe('Enter a valid date and time');
    expect(dueAtProblem(at(-5), now)).toBe('Choose a time in the future');
  });
  it('refuses a time more than two years ahead', () => {
    expect(dueAtProblem(at(MAX_DAYS_AHEAD * 1440 - 1), now)).toBeNull();
    expect(dueAtProblem(at(MAX_DAYS_AHEAD * 1440 + 1), now)).toBe(
      'Choose a time within the next two years',
    );
  });
});

describe('rescheduleNeedsReason (FR-102)', () => {
  it('is free for the first two reschedules of a follow-up that is not overdue', () => {
    expect(rescheduleNeedsReason({ rescheduleCount: 0, dueAt: at(60) }, now)).toBe(false);
    expect(rescheduleNeedsReason({ rescheduleCount: 1, dueAt: at(60) }, now)).toBe(false);
  });
  it('needs a reason from the third reschedule on', () => {
    expect(rescheduleNeedsReason({ rescheduleCount: 2, dueAt: at(60) }, now)).toBe(true);
    expect(rescheduleNeedsReason({ rescheduleCount: 5, dueAt: at(60) }, now)).toBe(true);
  });
  it('needs a reason when the follow-up is overdue', () => {
    expect(rescheduleNeedsReason({ rescheduleCount: 0, dueAt: at(-1) }, now)).toBe(true);
  });
});

describe('nextFollowUpAt (FR-108)', () => {
  it('is the earliest open follow-up, ignoring closed ones', () => {
    expect(
      nextFollowUpAt([
        { status: 'OPEN', dueAt: at(300) },
        { status: 'DONE', dueAt: at(10) },
        { status: 'OPEN', dueAt: at(120) },
        { status: 'CANCELLED', dueAt: at(5) },
      ]),
    ).toEqual(at(120));
  });
  it('is null without open follow-ups', () => {
    expect(nextFollowUpAt([])).toBeNull();
    expect(nextFollowUpAt([{ status: 'DONE', dueAt: at(10) }])).toBeNull();
  });
  it('includes an overdue open follow-up', () => {
    expect(
      nextFollowUpAt([
        { status: 'OPEN', dueAt: at(-60) },
        { status: 'OPEN', dueAt: at(60) },
      ]),
    ).toEqual(at(-60));
  });
});

describe('isOverdue', () => {
  it('only an open follow-up past its time is overdue', () => {
    expect(isOverdue({ status: 'OPEN', dueAt: at(-1) }, now)).toBe(true);
    expect(isOverdue({ status: 'OPEN', dueAt: at(1) }, now)).toBe(false);
    expect(isOverdue({ status: 'DONE', dueAt: at(-1) }, now)).toBe(false);
  });
});

describe('My Day (FR-101)', () => {
  const tomorrow = at(600); // the next local midnight
  const end = at(600 + 7 * 1440); // 7 local days later

  it('buckets: overdue before now, today until midnight, upcoming for 7 days, then nothing', () => {
    expect(myDayBucket(at(-1), now, tomorrow, end)).toBe('overdue');
    expect(myDayBucket(now, now, tomorrow, end)).toBe('today');
    expect(myDayBucket(at(599), now, tomorrow, end)).toBe('today');
    expect(myDayBucket(tomorrow, now, tomorrow, end)).toBe('upcoming');
    expect(myDayBucket(at(600 + 7 * 1440 - 1), now, tomorrow, end)).toBe('upcoming');
    expect(myDayBucket(end, now, tomorrow, end)).toBeNull();
  });

  it('orders by priority, then lead intent (Hot first, none last), then due time, then id', () => {
    const t = (id: string, priority: string, intent: string | null, minutes: number) => ({
      id,
      priority,
      intent,
      dueAt: at(minutes),
    });
    const items = [
      t('9', 'NORMAL', null, 10),
      t('8', 'LOW', 'HOT', 1),
      t('7', 'NORMAL', 'COLD', 5),
      t('6', 'NORMAL', 'HOT', 50),
      t('5', 'URGENT', 'COLD', 99),
      t('4', 'NORMAL', 'HOT', 20),
      t('3', 'HIGH', 'WARM', 30),
      t('2', 'NORMAL', 'HOT', 20),
    ];
    expect(items.sort(compareMyDay).map((i) => i.id)).toEqual([
      '5', // Urgent first, whatever the intent and time
      '3', // High
      '2', // Normal + Hot, 20 min (id breaks the tie with 4)
      '4',
      '6', // Normal + Hot, 50 min
      '7', // Normal + Cold
      '9', // Normal, no intent
      '8', // Low, even though Hot and earliest
    ]);
  });
});
