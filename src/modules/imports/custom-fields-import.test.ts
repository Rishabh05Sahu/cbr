// M5: custom fields in imports — explicit cell parsing, mapping (unknown/archived refused,
// required must be mapped), row validation with stable codes, and the CF_ problem-field encoding.
import { describe, expect, it } from 'vitest';
import {
  customCellValue,
  customIssueField,
  customKeyFromIssueField,
  type CustomFieldDefinition,
} from '@/modules/leads';
import { suggestMapping, validateMapping } from './mapping';
import { validateRow, type RowContext } from './rows';

const defs: CustomFieldDefinition[] = [
  { key: 'site_city', label: 'Site city', type: 'text', required: true },
  { key: 'family_size', label: 'Family size', type: 'number', required: false },
  { key: 'move_in', label: 'Move in', type: 'date', required: false },
  { key: 'nri', label: 'NRI', type: 'boolean', required: false },
  {
    key: 'facing',
    label: 'Facing',
    type: 'single_select',
    required: false,
    options: ['East', 'West'],
  },
  {
    key: 'amenities',
    label: 'Amenities',
    type: 'multi_select',
    required: false,
    options: ['Gym', 'Pool'],
  },
  { key: 'old_ref2', label: 'Old ref', type: 'text', required: false, archived: true },
];
const ctx: RowContext = {
  sourcesByName: new Map(),
  defaultSourceId: '0199a000-0000-7000-8000-000000000001',
  limits: { maxCellChars: 1000 },
  customFields: defs,
};
const mapping = {
  fullName: 0,
  primaryPhone: 1,
  'custom:site_city': 2,
  'custom:family_size': 3,
  'custom:move_in': 4,
  'custom:nri': 5,
  'custom:facing': 6,
  'custom:amenities': 7,
} as const;
const cells = (o: Partial<Record<number, string | number | boolean | Date>> = {}) => {
  const base: (string | number | boolean | Date | null)[] = [
    'Synthetic Lead',
    '9000000001',
    'Pune',
    '',
    '',
    '',
    '',
    '',
  ];
  for (const [i, v] of Object.entries(o)) base[Number(i)] = v ?? null;
  return base;
};

describe('cell values by declared type (no silent coercion)', () => {
  it.each([
    ['number', '4', 4],
    ['number', '-2.5', -2.5],
    ['boolean', 'Yes', true],
    ['boolean', 'FALSE', false],
    ['single_select', 'east', 'East'],
    ['multi_select', 'gym; Pool', ['Gym', 'Pool']],
    ['date', '2027-02-28', '2027-02-28'],
  ])('%s %j → %j', (type, text, value) => {
    const def = defs.find((d) => d.type === type)!;
    expect(customCellValue(def, text)).toEqual({ ok: true, value });
  });

  it.each([
    ['number', '1,200'],
    ['number', 'four'],
    ['boolean', 'maybe'],
    ['single_select', 'North'],
    ['multi_select', 'Gym;Sauna'],
  ])('%s %j is refused', (type, text) => {
    expect(
      customCellValue(
        defs.find((d) => d.type === type)!,
        text,
      ),
    ).toEqual({ ok: false });
  });

  it('an empty cell is no value', () => {
    expect(customCellValue(defs[0]!, '  ')).toEqual({ ok: true, value: undefined });
  });
});

describe('problem field names', () => {
  it('encode digits as letters and decode back; built-in names are not custom', () => {
    expect(customIssueField('old_ref2')).toBe('CF_old_refC');
    expect(customIssueField('old_ref2')).toMatch(/^[A-Za-z_]{1,50}$/); // import_row_result CHECK
    expect(customKeyFromIssueField('CF_old_refC')).toBe('old_ref2');
    expect(customKeyFromIssueField('primaryPhone')).toBeNull();
    const longest = `a${'9'.repeat(39)}`;
    expect(customIssueField(longest).length).toBeLessThanOrEqual(50);
    expect(customKeyFromIssueField(customIssueField(longest))).toBe(longest);
  });
});

describe('mapping', () => {
  const active = defs
    .filter((d) => !d.archived)
    .map((d) => ({ key: d.key, label: d.label, required: d.required }));

  it('active custom fields can be mapped; required ones must be', () => {
    expect(
      validateMapping({ fullName: 0, primaryPhone: 1, 'custom:site_city': 2 }, 3, active),
    ).toEqual({
      ok: true,
      mapping: { fullName: 0, primaryPhone: 1, 'custom:site_city': 2 },
    });
    expect(validateMapping({ fullName: 0, primaryPhone: 1 }, 3, active)).toEqual({
      ok: false,
      issues: [{ code: 'REQUIRED_UNMAPPED', field: 'custom:site_city' }],
    });
  });

  it('unknown or archived custom fields are refused', () => {
    const r = validateMapping(
      {
        fullName: 0,
        primaryPhone: 1,
        'custom:site_city': 2,
        'custom:old_ref2': 3,
        'custom:nope': 4,
      },
      5,
      active,
    );
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues).toEqual([
        { code: 'FIELD_UNKNOWN', field: 'custom:old_ref2' },
        { code: 'FIELD_UNKNOWN', field: 'custom:nope' },
      ]);
  });

  it('suggests a custom column from a matching header', () => {
    expect(suggestMapping(['Name', 'Mobile', 'Site City'], active)).toMatchObject({
      'custom:site_city': 2,
    });
  });
});

describe('row validation', () => {
  it('valid typed values come through', () => {
    const r = validateRow(
      cells({ 3: 4, 4: new Date('2027-02-28T00:00:00Z'), 5: true, 6: 'west', 7: 'Pool' }),
      2,
      mapping,
      ctx,
    );
    expect(r).toMatchObject({
      status: 'VALID',
      customFields: {
        site_city: 'Pune',
        family_size: 4,
        move_in: '2027-02-28',
        nri: true,
        facing: 'West',
        amenities: ['Pool'],
      },
    });
  });

  it('a missing required value and invalid values are row problems with stable codes', () => {
    const r = validateRow(cells({ 2: '', 3: 'four', 6: 'North' }), 3, mapping, ctx);
    expect(r.status).toBe('INVALID');
    if (r.status === 'INVALID')
      expect(r.issues).toEqual(
        expect.arrayContaining([
          { row: 3, field: 'CF_family_size', code: 'CUSTOM_FIELD_INVALID' },
          { row: 3, field: 'CF_facing', code: 'CUSTOM_FIELD_INVALID' },
          { row: 3, field: 'CF_site_city', code: 'CUSTOM_FIELD_REQUIRED' },
        ]),
      );
  });

  it('an impossible date is invalid (no rollover)', () => {
    const r = validateRow(cells({ 4: '2027-02-30' }), 4, mapping, ctx);
    expect(r.status === 'INVALID' && r.issues).toEqual([
      { row: 4, field: 'CF_move_in', code: 'CUSTOM_FIELD_INVALID' },
    ]);
  });
});
