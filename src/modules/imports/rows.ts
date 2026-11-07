// Row validation (FR-042) and in-file duplicate detection (FR-044). A spreadsheet row becomes the
// same input manual create accepts, then goes through the same rules (leads prepareLead), so an
// imported lead can never be something the form would refuse. Results carry row numbers, field
// names and codes only: never cell values (no raw rows in logs, errors or the job record).
import {
  createInput,
  customCellValue,
  customFieldsSchema,
  customIssueField,
  prepareLead,
  sourceKey,
  type CustomFieldDefinition,
  type FieldIssue,
  type PreparedLead,
} from '@/modules/leads';
import type { ImportLimits } from './limits';
import { customKeyOf, type ColumnMapping, type ImportField } from './mapping';

/** A cell as spreadsheet parsers return it. Formulas arrive as their cached value, never code. */
export type Cell = string | number | boolean | Date | null | undefined;

export interface RowIssue {
  /** 1-based row number as the user sees it in the spreadsheet. */
  row: number;
  field: string;
  code: string;
}

export type RowResult =
  | { status: 'EMPTY'; row: number }
  | { status: 'INVALID'; row: number; issues: RowIssue[] }
  | {
      status: 'VALID';
      row: number;
      lead: PreparedLead;
      sourceId: string;
      /** Typed custom values (M5); empty when the org has no custom fields mapped. */
      customFields: Record<string, unknown>;
    };

export interface RowContext {
  /** Active lead sources by lower-cased name. */
  sourcesByName: ReadonlyMap<string, string>;
  /** Used when the row has no source column or an empty source cell. */
  defaultSourceId: string;
  limits: Pick<ImportLimits, 'maxCellChars'>;
  /**
   * The org's ACTIVE custom field definitions (M5). Values are validated strictly, required ones
   * included, exactly as manual create; problems are CUSTOM_FIELD_INVALID / CUSTOM_FIELD_REQUIRED
   * on field customIssueField(key).
   */
  customFields?: readonly CustomFieldDefinition[];
}

/** Cell → text. Whole numbers keep all digits (Excel stores phone numbers as numbers). */
export function cellText(cell: Cell): string {
  if (cell == null) return '';
  if (typeof cell === 'string') return cell.trim();
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return '';
    return Number.isInteger(cell) && Math.abs(cell) < 1e21 ? cell.toFixed(0) : String(cell);
  }
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10);
}

const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Common spellings in portal exports → the lead vocabularies (lead-lifecycle §4). */
const VOCAB: Partial<Record<ImportField, Record<string, string>>> = {
  transactionType: {
    buy: 'BUY',
    purchase: 'BUY',
    rent: 'RENT',
    rental: 'RENT',
    'lease commercial': 'LEASE_COMMERCIAL',
    'commercial lease': 'LEASE_COMMERCIAL',
    sell: 'SELL',
    sale: 'SELL',
    'let out': 'LET_OUT',
  },
  propertyType: {
    apartment: 'APARTMENT',
    flat: 'APARTMENT',
    villa: 'VILLA',
    bungalow: 'VILLA',
    'independent house': 'VILLA',
    plot: 'PLOT',
    land: 'PLOT',
    'row house': 'ROW_HOUSE',
    rowhouse: 'ROW_HOUSE',
    office: 'OFFICE',
    'office space': 'OFFICE',
    shop: 'SHOP',
    showroom: 'SHOP',
    warehouse: 'WAREHOUSE',
    godown: 'WAREHOUSE',
    other: 'OTHER',
  },
  purpose: { 'self use': 'SELF_USE', 'end use': 'SELF_USE', investment: 'INVESTMENT' },
  intent: { hot: 'HOT', warm: 'WARM', cold: 'COLD' },
  timeline: {
    immediate: 'IMMEDIATE',
    'within 1 month': 'WITHIN_1M',
    '1 3 months': '1_3M',
    '3 6 months': '3_6M',
    '6 months plus': '6M_PLUS',
  },
  preferredContactMethod: {
    phone: 'PHONE',
    call: 'PHONE',
    whatsapp: 'WHATSAPP',
    email: 'EMAIL',
    any: 'ANY',
  },
  preferredLanguage: {
    english: 'en',
    hindi: 'hi',
    marathi: 'mr',
    gujarati: 'gu',
    kannada: 'kn',
    tamil: 'ta',
    telugu: 'te',
    bengali: 'bn',
    malayalam: 'ml',
  },
};

/** Exact codes ("LET_OUT") pass through; known spellings map; anything else is left for zod. */
function vocabValue(field: ImportField, text: string): string {
  const map = VOCAB[field];
  if (!map || !text) return text;
  return (
    map[key(text)] ?? (field === 'preferredLanguage' ? text.toLowerCase() : text.toUpperCase())
  );
}

/** "2 BHK" → "2". */
const bhkValue = (text: string) => text.replace(/\s*bhk$/i, '');

/** zod issue codes → stable row codes. */
const zodCode = (code: string) =>
  ({
    too_big: 'VALUE_TOO_LONG',
    too_small: 'VALUE_REQUIRED',
    invalid_value: 'VALUE_NOT_ALLOWED',
    invalid_format: 'VALUE_INVALID_FORMAT',
    invalid_type: 'VALUE_INVALID',
  })[code] ?? 'VALUE_INVALID';

export function validateRow(
  cells: readonly Cell[],
  row: number,
  mapping: ColumnMapping,
  ctx: RowContext,
): RowResult {
  const values: Partial<Record<ImportField, string>> = {};
  const customText = new Map<string, string>();
  const issues: RowIssue[] = [];
  for (const [field, column] of Object.entries(mapping) as [string, number][]) {
    const text = cellText(cells[column]);
    const customKey = customKeyOf(field);
    const issueField = customKey === null ? field : customIssueField(customKey);
    if (text.length > ctx.limits.maxCellChars)
      issues.push({ row, field: issueField, code: 'CELL_TOO_LONG' });
    else if (customKey !== null) customText.set(customKey, text);
    else values[field as ImportField] = text;
  }
  if (
    !issues.length &&
    Object.values(values).every((v) => !v) &&
    [...customText.values()].every((v) => !v)
  )
    return { status: 'EMPTY', row };
  const customFields = customValues(row, customText, ctx.customFields ?? [], issues);

  let sourceId = ctx.defaultSourceId;
  if (values.source) {
    const found = ctx.sourcesByName.get(sourceKey(values.source));
    if (found) sourceId = found;
    else issues.push({ row, field: 'source', code: 'SOURCE_UNKNOWN' });
  }

  const record: Record<string, string> = {};
  for (const [field, text] of Object.entries(values) as [ImportField, string][]) {
    if (field === 'source') continue;
    record[field] =
      field === 'bhkMin' || field === 'bhkMax' ? bhkValue(text) : vocabValue(field, text);
  }
  record.fullName ??= '';
  record.primaryPhone ??= '';

  let parsed = createInput.safeParse(record);
  if (!parsed.success) {
    // Report every problem in one pass: re-check the remaining fields (phones, budgets) with
    // the failing ones left out. The placeholder name is never stored: the row stays invalid.
    const failed = new Set<string>();
    for (const i of parsed.error.issues) {
      failed.add(String(i.path[0] ?? '_'));
      issues.push({ row, field: String(i.path[0] ?? '_'), code: zodCode(i.code) });
    }
    const rest = Object.fromEntries(Object.entries(record).filter(([f]) => !failed.has(f)));
    parsed = createInput.safeParse({ fullName: '-', primaryPhone: '', ...rest });
    if (!parsed.success) return { status: 'INVALID', row, issues };
    const second = prepareLead(parsed.data);
    if (!second.ok)
      for (const i of second.issues)
        if (!failed.has(i.field) && !(i.code === 'PHONE_REQUIRED' && failed.has('primaryPhone')))
          issues.push({ row, field: i.field, code: i.code });
    return { status: 'INVALID', row, issues };
  }
  const prepared = prepareLead(parsed.data);
  if (!prepared.ok) {
    issues.push(...prepared.issues.map((i: FieldIssue) => ({ row, field: i.field, code: i.code })));
    return { status: 'INVALID', row, issues };
  }
  if (issues.length) return { status: 'INVALID', row, issues };
  return { status: 'VALID', row, lead: prepared.lead, sourceId, customFields };
}

/** Typed custom values for one row; problems are appended to `issues` (no cell values). */
function customValues(
  row: number,
  texts: ReadonlyMap<string, string>,
  defs: readonly CustomFieldDefinition[],
  issues: RowIssue[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const bad = new Set<string>();
  for (const [key, text] of texts) {
    const def = defs.find((d) => d.key === key && !d.archived);
    const v = def ? customCellValue(def, text) : { ok: false as const };
    if (!v.ok) {
      bad.add(key);
      issues.push({ row, field: customIssueField(key), code: 'CUSTOM_FIELD_INVALID' });
    } else if (v.value !== undefined) out[key] = v.value;
  }
  if (!defs.length) return out;
  const parsed = customFieldsSchema(defs, { requireRequired: true }).safeParse(out);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const keys = issue.code === 'unrecognized_keys' ? issue.keys : [String(issue.path[0] ?? '')];
      for (const key of keys) {
        if (!key || bad.has(key)) continue;
        bad.add(key);
        const missing = !(key in out);
        issues.push({
          row,
          field: customIssueField(key),
          code: missing ? 'CUSTOM_FIELD_REQUIRED' : 'CUSTOM_FIELD_INVALID',
        });
      }
    }
  return out;
}

/**
 * In-file duplicates (FR-044), policy "keep first": a row whose primary or alternate phone was
 * already used by an earlier valid row is a duplicate of that row.
 */
export class InFileDuplicates {
  private readonly firstRowByPhone = new Map<string, number>();

  /** Returns the earlier row number, or null after registering this row's phones. */
  check(row: number, phones: readonly string[]): number | null {
    for (const p of phones) {
      const first = this.firstRowByPhone.get(p);
      if (first !== undefined) return first;
    }
    for (const p of phones) this.firstRowByPhone.set(p, row);
    return null;
  }
}
