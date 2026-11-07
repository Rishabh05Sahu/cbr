// M5 §I.4 U4: server field errors are shown by their visible label, never the internal name.
import { describe, expect, it } from 'vitest';
import { fieldErrorLines, humanizeFieldName } from './action-form';

describe('humanizeFieldName', () => {
  it.each([
    ['fullName', 'Full name'],
    ['key', 'Key'],
    ['preferred_city', 'Preferred city'],
    ['alternatePhoneE164', 'Alternate phone e164'],
    ['keep.budgetMin', 'Budget min'],
  ])('%s → %s', (name, label) => expect(humanizeFieldName(name)).toBe(label));
});

describe('fieldErrorLines', () => {
  it('uses the given labels, then a humanised name; never the raw key', () => {
    const lines = fieldErrorLines(
      { fullName: ['Choose which value to keep'], key: ['Use 2–40 lower-case letters'] },
      { fullName: 'Name' },
    );
    expect(lines).toEqual(['Name: Choose which value to keep', 'Key: Use 2–40 lower-case letters']);
    expect(lines.join(' ')).not.toMatch(/fullName|key:/);
  });

  it('custom-field and form-level messages already say what they are about', () => {
    expect(
      fieldErrorLines({
        'customFields.site_city': ['Site city is required'],
        _: ['Something about the whole form'],
      }),
    ).toEqual(['Site city is required', 'Something about the whole form']);
  });
});
