// Custom lead fields (FR-064, lead-lifecycle §4.1): org-defined fields whose values live in
// Lead.custom_fields (JSONB) and are validated on the server by a Zod schema built from the
// definitions. Pure: no database access. Storage (custom_field_definition table, the lead column,
// RLS and grants) waits for migration 0006 (docs/PHASE-2-M5-PROPOSAL.md).
import { z } from 'zod';

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'single_select',
  'multi_select',
  'boolean',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** At most this many active (non-archived) definitions per org. */
export const MAX_ACTIVE_CUSTOM_FIELDS = 30;
export const MAX_OPTIONS = 50;
export const MAX_TEXT = 500;
/** Serialised size cap for one lead's values (mirrored by a CHECK in 0006). */
export const MAX_VALUES_BYTES = 16_384;

/** Keys are stable identifiers (labels can change): lower snake case, not a core field name. */
const KEY = /^[a-z][a-z0-9_]{1,39}$/;
/** Core lead fields a custom field must not shadow (imports and exports use these names). */
const RESERVED_KEYS = new Set([
  'id',
  'org_id',
  'full_name',
  'name',
  'phone',
  'email',
  'stage',
  'owner',
  'source',
  'budget',
  'created_at',
  'updated_at',
]);

const option = z.string().trim().min(1).max(100);

export const customFieldDefinitionInput = z
  .object({
    key: z
      .string()
      .regex(KEY, 'Use 2–40 lower-case letters, digits and underscores, starting with a letter')
      .refine((k) => !RESERVED_KEYS.has(k), 'This key is reserved for a built-in field'),
    label: z.string().trim().min(1).max(100),
    type: z.enum(CUSTOM_FIELD_TYPES),
    required: z.boolean().default(false),
    options: z.array(option).max(MAX_OPTIONS).optional(),
  })
  .superRefine((d, ctx) => {
    const isSelect = d.type === 'single_select' || d.type === 'multi_select';
    if (isSelect && (!d.options || d.options.length === 0))
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least one option' });
    if (!isSelect && d.options?.length)
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only select fields have options',
      });
    if (d.options && new Set(d.options.map((o) => o.toLowerCase())).size !== d.options.length)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique' });
  });
export type CustomFieldDefinitionInput = z.infer<typeof customFieldDefinitionInput>;

export interface CustomFieldDefinition {
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  options?: readonly string[];
  /** Archived fields keep their stored values but accept no new ones. */
  archived?: boolean;
}

/** Org-level rules over a set of definitions (count, unique keys). */
export function checkDefinitionSet(defs: readonly CustomFieldDefinition[]): string[] {
  const problems: string[] = [];
  const active = defs.filter((d) => !d.archived);
  if (active.length > MAX_ACTIVE_CUSTOM_FIELDS)
    problems.push(`At most ${MAX_ACTIVE_CUSTOM_FIELDS} active custom fields`);
  if (new Set(defs.map((d) => d.key)).size !== defs.length) problems.push('Keys must be unique');
  return problems;
}

/** ISO calendar date (YYYY-MM-DD) that really exists. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a real date');

function valueSchema(d: CustomFieldDefinition): z.ZodType {
  switch (d.type) {
    case 'text':
      return z.string().trim().min(1).max(MAX_TEXT);
    case 'number':
      return z.number().finite().gte(-1e12).lte(1e12);
    case 'date':
      return isoDate;
    case 'boolean':
      return z.boolean();
    case 'single_select':
      return z.enum(d.options as [string, ...string[]]);
    case 'multi_select':
      return z
        .array(z.enum(d.options as [string, ...string[]]))
        .min(1)
        .max(MAX_OPTIONS)
        .refine((a) => new Set(a).size === a.length, 'Choose each option once');
  }
}

/** What a user must do to fix an invalid value, naming the field by its label (M5 §I.4 U8). */
function invalidMessage(d: CustomFieldDefinition): string {
  switch (d.type) {
    case 'text':
      return `${d.label}: enter between 1 and ${MAX_TEXT} characters`;
    case 'number':
      return `${d.label}: enter a number`;
    case 'date':
      return `${d.label}: enter a real date (YYYY-MM-DD)`;
    case 'boolean':
      return `${d.label}: choose Yes or No`;
    case 'single_select':
      return `${d.label}: choose one of the listed options`;
    case 'multi_select':
      return `${d.label}: choose one or more of the listed options, each once`;
  }
}

/**
 * One field's value: the same strict type rules as before, but with messages a user can act on
 * instead of the schema library's ("expected string, received undefined"). Missing or null is
 * refused for a required field; otherwise it passes through (null clears the value).
 */
function fieldSchema(d: CustomFieldDefinition, required: boolean): z.ZodType {
  const inner = valueSchema(d);
  const checked = z.unknown().transform((x, ctx) => {
    if (x === undefined || x === null) {
      if (!required) return x;
      ctx.addIssue({ code: 'custom', message: `${d.label} is required` });
      return z.NEVER;
    }
    const r = inner.safeParse(x);
    if (r.success) return r.data;
    ctx.addIssue({ code: 'custom', message: invalidMessage(d) });
    return z.NEVER;
  });
  return required ? checked : checked.optional();
}

/**
 * The Zod schema for one lead's custom values. Unknown keys and archived fields are refused
 * (never stored silently); `null` clears a value; required fields must be present on create.
 */
export function customFieldsSchema(
  defs: readonly CustomFieldDefinition[],
  opts: { requireRequired: boolean } = { requireRequired: true },
) {
  const active = defs.filter((d) => !d.archived);
  const shape: Record<string, z.ZodType> = {};
  for (const d of active) shape[d.key] = fieldSchema(d, d.required && opts.requireRequired);
  return z
    .strictObject(shape)
    .refine(
      (o) => new TextEncoder().encode(JSON.stringify(o)).byteLength <= MAX_VALUES_BYTES,
      'Custom field values are too large',
    );
}

/** Merges validated changes into stored values; `null` removes a key. */
export function applyCustomFieldChanges(
  stored: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Imports (M5): custom values from spreadsheet cells, and how row problems name a custom field.

const DIGIT_LETTERS = 'ABCDEFGHIJ';

/**
 * The `field` an import row problem uses for a custom field. import_row_result.field allows only
 * letters and underscores, and custom keys are lower case with digits, so: "CF_" + the key with
 * each digit written as an upper-case letter (0 → A … 9 → J). Unambiguous and reversible, and
 * never equal to a built-in field name (those start with a lower-case letter).
 */
export function customIssueField(key: string): string {
  return `CF_${key.replace(/\d/g, (d) => DIGIT_LETTERS[Number(d)]!)}`;
}

/** The custom key of an import problem field, or null for a built-in field. */
export function customKeyFromIssueField(field: string): string | null {
  if (!/^CF_[a-zA-Z_]+$/.test(field)) return null;
  return field.slice(3).replace(/[A-J]/g, (l) => String(DIGIT_LETTERS.indexOf(l)));
}

/**
 * One spreadsheet cell (already turned into text) as the typed value a field takes. The rules are
 * explicit and documented, never a silent coercion: anything else is refused for the row.
 * - number: an optional minus sign, digits, an optional decimal part ("1,200" is refused);
 * - date: YYYY-MM-DD (Excel date cells arrive in this form);
 * - boolean: true/false or yes/no, any case (Excel TRUE/FALSE cells arrive as text);
 * - single select: an option, matched ignoring case, stored with the option's own spelling;
 * - multi select: options separated by ";" (each matched as above);
 * - text: as is. An empty cell gives no value.
 */
export function customCellValue(
  def: Pick<CustomFieldDefinition, 'type' | 'options'>,
  text: string,
): { ok: true; value: unknown } | { ok: false } | { ok: true; value: undefined } {
  const t = text.trim();
  if (!t) return { ok: true, value: undefined };
  const option = (v: string) =>
    def.options?.find((o) => o.toLowerCase() === v.trim().toLowerCase());
  switch (def.type) {
    case 'text':
      return { ok: true, value: t };
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(t) ? { ok: true, value: Number(t) } : { ok: false };
    case 'date':
      return { ok: true, value: t }; // the value schema checks it is a real YYYY-MM-DD date
    case 'boolean': {
      const v = t.toLowerCase();
      if (v === 'true' || v === 'yes') return { ok: true, value: true };
      if (v === 'false' || v === 'no') return { ok: true, value: false };
      return { ok: false };
    }
    case 'single_select': {
      const o = option(t);
      return o ? { ok: true, value: o } : { ok: false };
    }
    case 'multi_select': {
      const parts = t.split(';').filter((p) => p.trim());
      const opts = parts.map(option);
      return opts.every(Boolean) ? { ok: true, value: opts } : { ok: false };
    }
  }
}
