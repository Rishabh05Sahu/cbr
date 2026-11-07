// FR-151/152 site-visit rules (ADR-0022): allowed actions per status, final closed visits, the
// outcome only from the visit's day, and objections parsing.
import { describe, expect, it } from 'vitest';
import {
  isOpen,
  outcomeTooEarly,
  parseObjections,
  targetOf,
  transitionProblem,
  VISIT_ACTIONS,
} from './rules';

describe('transitions', () => {
  it('an open visit may take every action, except confirming a confirmed one', () => {
    for (const s of ['SCHEDULED', 'RESCHEDULED'] as const)
      for (const a of VISIT_ACTIONS) expect(transitionProblem(s, a)).toBeNull();
    expect(transitionProblem('CONFIRMED', 'confirm')).toBe('This visit is already confirmed');
    expect(transitionProblem('CONFIRMED', 'attended')).toBeNull();
  });
  it('a closed visit never changes', () => {
    for (const s of ['CANCELLED', 'ATTENDED', 'NO_SHOW'] as const) {
      expect(isOpen(s)).toBe(false);
      for (const a of VISIT_ACTIONS)
        expect(transitionProblem(s, a)).toMatch(/^This visit is already /);
    }
  });
  it('maps actions to statuses', () => {
    expect(VISIT_ACTIONS.map(targetOf)).toEqual([
      'CONFIRMED',
      'RESCHEDULED',
      'CANCELLED',
      'NO_SHOW',
      'ATTENDED',
    ]);
  });
});

describe('outcome timing and objections', () => {
  it('attended / no-show from the visit day onwards', () => {
    expect(outcomeTooEarly('2026-11-02', '2026-11-01')).toBe(true);
    expect(outcomeTooEarly('2026-11-02', '2026-11-02')).toBe(false);
    expect(outcomeTooEarly('2026-11-02', '2026-11-03')).toBe(false);
  });
  it('splits, trims and removes repeats', () => {
    expect(parseObjections('Price, parking ,price,\nLocation')).toEqual([
      'Price',
      'parking',
      'Location',
    ]);
    expect(parseObjections(undefined)).toEqual([]);
  });
});
