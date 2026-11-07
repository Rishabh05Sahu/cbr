// FR-104 meeting rules: the end is required, after the start and at most 24 hours later; overlap
// of [start, end) intervals (a start-only meeting counts as its minute); the datetime-local value
// in the org's time zone used to prefill the edit form.
import { describe, expect, it } from 'vitest';
import { meetingEndProblem, meetingsOverlap, orgLocalInput } from './follow-up-rules';

const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00Z`);

describe('meetingEndProblem', () => {
  it('requires an end after the start, within 24 hours', () => {
    expect(meetingEndProblem(at('10:00'), null)).toBe('Enter when the meeting ends');
    expect(meetingEndProblem(at('10:00'), at('10:00'))).toBe('The end must be after the start');
    expect(meetingEndProblem(at('10:00'), at('09:59'))).toBe('The end must be after the start');
    expect(meetingEndProblem(at('10:00'), at('10:01'))).toBeNull();
    expect(meetingEndProblem(at('10:00'), new Date('2026-11-03T10:00:00Z'))).toBeNull();
    expect(meetingEndProblem(at('10:00'), new Date('2026-11-03T10:01:00Z'))).toBe(
      'A meeting can last at most 24 hours',
    );
  });
});

describe('meetingsOverlap', () => {
  const m = (start: string, end: string | null) => ({
    dueAt: at(start),
    endAt: end ? at(end) : null,
  });
  it('treats meetings as half-open intervals', () => {
    expect(meetingsOverlap(m('10:00', '11:00'), m('10:30', '11:30'))).toBe(true);
    expect(meetingsOverlap(m('10:00', '11:00'), m('09:00', '12:00'))).toBe(true);
    // Back to back is not an overlap.
    expect(meetingsOverlap(m('10:00', '11:00'), m('11:00', '12:00'))).toBe(false);
    expect(meetingsOverlap(m('11:00', '12:00'), m('10:00', '11:00'))).toBe(false);
  });
  it('counts a start-only meeting as its minute', () => {
    expect(meetingsOverlap(m('10:00', '11:00'), m('10:30', null))).toBe(true);
    expect(meetingsOverlap(m('10:30', null), m('10:30', null))).toBe(true);
    expect(meetingsOverlap(m('11:00', null), m('10:00', '11:00'))).toBe(false);
  });
});

describe('orgLocalInput', () => {
  it('formats in the org time zone', () => {
    expect(orgLocalInput(new Date('2026-11-02T04:30:00Z'), 'Asia/Kolkata')).toBe(
      '2026-11-02T10:00',
    );
    expect(orgLocalInput(new Date('2026-11-02T20:00:00Z'), 'Asia/Kolkata')).toBe(
      '2026-11-03T01:30',
    );
  });
});
