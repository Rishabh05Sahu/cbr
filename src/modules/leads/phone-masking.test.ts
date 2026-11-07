// FR-060 masking format (ADR-0013).
import { describe, expect, it } from 'vitest';
import { maskPhone, phoneDisplay } from './phone-masking';

describe('maskPhone', () => {
  it('keeps the Indian country code and the last four digits', () => {
    expect(maskPhone('+919803704066')).toBe('+91 ••••••4066');
  });
  it('keeps only the last four digits of other numbers', () => {
    expect(maskPhone('+14155550123')).toBe('•••••••0123');
    expect(maskPhone('+4412')).toBe('••4412'); // very short numbers still show a mask
  });
  it('never contains the hidden digits', () => {
    const m = maskPhone('+919803704066');
    expect(m).not.toMatch(/980370/);
    expect(m.replace(/\D/g, '')).toBe('914066');
  });
});

describe('phoneDisplay', () => {
  it('masks only when the org setting is on, and keeps null as null', () => {
    const on = phoneDisplay({ enabled: true, dailyCap: 50 });
    const off = phoneDisplay({ enabled: false, dailyCap: 50 });
    expect(on('+919803704066')).toBe('+91 ••••••4066');
    expect(off('+919803704066')).toBe('+919803704066');
    expect(on(null)).toBeNull();
  });
});
