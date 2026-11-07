import { describe, expect, it } from 'vitest';
import { normalisePhone } from './index';

describe('normalisePhone', () => {
  it.each([
    ['98765 43210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['+919876543210', '+919876543210'],
    ['+44 20 7946 0958', '+442079460958'],
    ['', null],
  ])('%s -> %s', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  it.each(['12345', '5876543210', 'abc', '+0123456789'])('rejects %s', (input) => {
    expect(() => normalisePhone(input)).toThrow(/valid mobile/);
  });
});
