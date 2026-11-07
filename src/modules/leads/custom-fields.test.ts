import { describe, expect, it } from 'vitest';
import {
  applyCustomFieldChanges,
  checkDefinitionSet,
  customFieldDefinitionInput,
  customFieldsSchema,
  MAX_ACTIVE_CUSTOM_FIELDS,
  type CustomFieldDefinition,
} from './custom-fields';

const defs: CustomFieldDefinition[] = [
  { key: 'project_name', label: 'Project', type: 'text', required: true },
  { key: 'carpet_area', label: 'Carpet area (sq ft)', type: 'number', required: false },
  { key: 'possession_by', label: 'Possession by', type: 'date', required: false },
  { key: 'loan_needed', label: 'Home loan', type: 'boolean', required: false },
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
    options: ['Gym', 'Pool', 'Clubhouse'],
  },
  { key: 'old_code', label: 'Old code', type: 'text', required: false, archived: true },
];

describe('custom field definitions', () => {
  it('accepts well-formed definitions', () => {
    expect(
      customFieldDefinitionInput.parse({
        key: 'facing',
        label: 'Facing',
        type: 'single_select',
        options: ['East'],
      }),
    ).toMatchObject({ key: 'facing', required: false });
  });

  it.each([
    [{ key: 'Facing', label: 'F', type: 'text' }, 'key'],
    [{ key: 'phone', label: 'Phone', type: 'text' }, 'key'],
    [{ key: 'x', label: 'X', type: 'text' }, 'key'],
    [{ key: 'facing', label: 'F', type: 'single_select' }, 'options'],
    [{ key: 'facing', label: 'F', type: 'single_select', options: ['East', 'east'] }, 'options'],
    [{ key: 'area', label: 'A', type: 'number', options: ['1'] }, 'options'],
    [{ key: 'area', label: 'A', type: 'colour' }, 'type'],
  ])('refuses %j (%s)', (input, path) => {
    const r = customFieldDefinitionInput.safeParse(input);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path[0])).toContain(path);
  });

  it('caps active definitions at 30 and needs unique keys; archived ones do not count', () => {
    const many = Array.from({ length: MAX_ACTIVE_CUSTOM_FIELDS + 1 }, (_, i) => ({
      key: `f_${i}`,
      label: `F ${i}`,
      type: 'text' as const,
      required: false,
    }));
    expect(checkDefinitionSet(many)).toEqual(['At most 30 active custom fields']);
    expect(
      checkDefinitionSet(many.map((d, i) => (i === 0 ? { ...d, archived: true } : d))),
    ).toEqual([]);
    expect(checkDefinitionSet([many[0]!, many[0]!])).toEqual(['Keys must be unique']);
  });
});

describe('custom field values', () => {
  const schema = customFieldsSchema(defs);

  it('accepts valid values of every type', () => {
    const v = {
      project_name: 'Synthetic Heights',
      carpet_area: 950.5,
      possession_by: '2027-03-31',
      loan_needed: true,
      facing: 'East',
      amenities: ['Gym', 'Pool'],
    };
    expect(schema.parse(v)).toEqual(v);
  });

  it.each([
    [{}, 'project_name'], // required on create
    [{ project_name: 'P', carpet_area: '950' }, 'carpet_area'], // no string → number coercion
    [{ project_name: 'P', possession_by: '2027-02-30' }, 'possession_by'],
    [{ project_name: 'P', possession_by: '31/03/2027' }, 'possession_by'],
    [{ project_name: 'P', loan_needed: 'yes' }, 'loan_needed'],
    [{ project_name: 'P', facing: 'North' }, 'facing'],
    [{ project_name: 'P', amenities: ['Gym', 'Gym'] }, 'amenities'],
    [{ project_name: 'P', amenities: [] }, 'amenities'],
    [{ project_name: 'P', old_code: 'X1' }, 'old_code'], // archived: no new values
    [{ project_name: 'P', owner_user_id: 'x' }, 'owner_user_id'], // unknown key
  ])('refuses %j at %s', (value, key) => {
    const r = schema.safeParse(value);
    expect(r.success).toBe(false);
    if (!r.success)
      expect(
        r.error.issues.flatMap((i) => [...i.path, ...((i as { keys?: string[] }).keys ?? [])]),
      ).toContain(key);
  });

  it('caps the stored size', () => {
    const big = customFieldsSchema(
      Array.from({ length: 30 }, (_, i) => ({
        key: `t_${i}`,
        label: 'T',
        type: 'text' as const,
        required: false,
      })),
    );
    const value = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`t_${i}`, 'x'.repeat(500)]),
    );
    expect(big.safeParse(value).success).toBe(true);
    const value2 = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`t_${i}`, 'é'.repeat(500)]),
    );
    expect(big.safeParse(value2).success).toBe(false); // 30 × 1,000 bytes > 16 KB
  });

  it('updates may omit required fields and clear optional ones with null', () => {
    const partial = customFieldsSchema(defs, { requireRequired: false });
    expect(partial.parse({ facing: null })).toEqual({ facing: null });
    expect(
      applyCustomFieldChanges(
        { project_name: 'P', facing: 'East' },
        { facing: null, carpet_area: 10 },
      ),
    ).toEqual({
      project_name: 'P',
      carpet_area: 10,
    });
  });
});

describe('custom field messages (M5 §I.4 U8)', () => {
  const messages = (input: Record<string, unknown>) => {
    const r = customFieldsSchema(defs).safeParse(input);
    return r.success ? [] : r.error.issues.map((i) => [i.path.join('.'), i.message]);
  };

  it('a missing required value names the field instead of the schema library text', () => {
    expect(messages({})).toEqual([['project_name', 'Project is required']]);
    expect(messages({ project_name: null })).toEqual([['project_name', 'Project is required']]);
  });

  it('invalid values say what to enter, by label, and are still refused', () => {
    expect(
      messages({
        project_name: '   ',
        carpet_area: '1,200',
        possession_by: '2027-02-30',
        loan_needed: 'maybe',
        facing: 'North',
        amenities: ['Gym', 'Gym'],
      }),
    ).toEqual([
      ['project_name', 'Project: enter between 1 and 500 characters'],
      ['carpet_area', 'Carpet area (sq ft): enter a number'],
      ['possession_by', 'Possession by: enter a real date (YYYY-MM-DD)'],
      ['loan_needed', 'Home loan: choose Yes or No'],
      ['facing', 'Facing: choose one of the listed options'],
      ['amenities', 'Amenities: choose one or more of the listed options, each once'],
    ]);
    for (const [, m] of messages({ carpet_area: 'x' })) expect(m).not.toMatch(/expected|received/);
  });
});
