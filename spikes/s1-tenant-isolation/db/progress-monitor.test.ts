// Unit tests (no database): S1-08's progress monitor with simulated clocks. On-time progress
// keeps the run valid; any gap over 120 s, during the run or before its end, makes it invalid.
import { describe, expect, it } from 'vitest';
import { MAX_PROGRESS_GAP_MS, ProgressMonitor } from './progress-monitor';

const T0 = Date.parse('2026-10-22T10:15:00.000Z');

/** Simulated clocks; `suspend` advances both without a progress observation. */
function clocks(monotonicAdvancesDuringSuspend = true) {
  let mono = 1_000;
  let wall = T0;
  return {
    c: { monotonicMs: () => mono, wallMs: () => wall },
    advance(ms: number) {
      mono += ms;
      wall += ms;
    },
    suspend(ms: number) {
      if (monotonicAdvancesDuringSuspend) mono += ms;
      wall += ms;
    },
  };
}

describe('ProgressMonitor', () => {
  it('on-time progress (every 60 s, some late by up to 60 s) keeps the run valid', () => {
    const t = clocks();
    const m = new ProgressMonitor(t.c);
    for (const ms of [60_000, 60_000, 95_000, 60_000, 120_000, 60_000]) {
      t.advance(ms);
      expect(m.observe('progress tick')).toBeNull();
    }
    t.advance(30_000);
    expect(m.observe('end of run')).toBeNull();
    expect(m.validForAcceptance).toBe(true);
    expect(m.gapCount).toBe(0);
    expect(m.startedAtUtc).toBe('2026-10-22T10:15:00.000Z');
  });

  it('a 1,010 s suspension between ticks makes the run invalid and records both timestamps', () => {
    const t = clocks();
    const m = new ProgressMonitor(t.c);
    t.advance(60_000);
    m.observe('progress tick');
    t.suspend(1_010_000);
    t.advance(41_000);
    const gap = m.observe('progress tick');
    expect(gap).toEqual({
      observed: 'no progress observation for more than 120 s (before progress tick)',
      fromUtc: '2026-10-22T10:16:00.000Z',
      toUtc: '2026-10-22T10:33:31.000Z',
      monotonicGapMs: 1_051_000,
      wallClockGapMs: 1_051_000,
      inferredCause:
        'not determined: host sleep/standby, process suspension or an event-loop stall',
    });
    expect(m.validForAcceptance).toBe(false);
    // Later on-time progress does not make the run valid again.
    t.advance(60_000);
    m.observe('progress tick');
    expect(m.validForAcceptance).toBe(false);
    expect(m.invalidRunMessage()).toMatch(
      /^S1-08 run invalid for acceptance: 1 progress gap\(s\) over 120 s observed \(largest 1051\.0 s, first from 2026-10-22T10:16:00\.000Z to 2026-10-22T10:33:31\.000Z\); cause not determined$/,
    );
  });

  it('a gap after the last tick is caught at the end of the run', () => {
    const t = clocks();
    const m = new ProgressMonitor(t.c);
    t.advance(60_000);
    m.observe('progress tick');
    t.advance(MAX_PROGRESS_GAP_MS + 1);
    expect(m.observe('end of run')?.observed).toMatch(/before end of run/);
    expect(m.validForAcceptance).toBe(false);
  });

  it('exactly 120 s is not a gap; 120.001 s is', () => {
    const t = clocks();
    const m = new ProgressMonitor(t.c);
    t.advance(120_000);
    expect(m.observe('progress tick')).toBeNull();
    t.advance(120_001);
    expect(m.observe('progress tick')).not.toBeNull();
  });

  it('is caught by the wall clock even if the monotonic clock stood still', () => {
    const t = clocks(false);
    const m = new ProgressMonitor(t.c);
    t.suspend(600_000);
    const gap = m.observe('progress tick');
    expect(gap).toMatchObject({ monotonicGapMs: 0, wallClockGapMs: 600_000 });
    expect(m.validForAcceptance).toBe(false);
  });

  it('counts every gap but keeps the first 20 samples', () => {
    const t = clocks();
    const m = new ProgressMonitor(t.c);
    for (let k = 0; k < 25; k++) {
      t.advance(200_000);
      m.observe('progress tick');
    }
    expect(m.gapCount).toBe(25);
    expect(m.gaps).toHaveLength(20);
  });
});
