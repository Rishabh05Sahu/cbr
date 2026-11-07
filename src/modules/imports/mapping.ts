// Column mapping (FR-041): which spreadsheet column feeds which lead field. The fields are the
// existing manual-create fields (leads createInput) plus `source`, matched by name to the org's
// lead sources, plus the org's ACTIVE custom fields as "custom:<key>" (M5); nothing here defines a
// second lead model. A required custom field must be mapped, as manual create requires it.
import type { CreateInput } from '@/modules/leads';

export type ImportField = Exclude<keyof CreateInput, 'sourceId'> | 'source';

export interface ImportFieldSpec {
  field: ImportField;
  label: string;
  required: boolean;
  /** Normalised header spellings that auto-suggest this field. */
  headers: readonly string[];
  hint?: string;
}

export const IMPORT_FIELDS: readonly ImportFieldSpec[] = [
  {
    field: 'fullName',
    label: 'Customer name',
    required: true,
    headers: ['name', 'fullname', 'customername', 'leadname', 'clientname', 'contactname'],
  },
  {
    field: 'primaryPhone',
    label: 'Phone',
    required: true,
    headers: [
      'phone',
      'mobile',
      'mobileno',
      'mobilenumber',
      'phoneno',
      'phonenumber',
      'contactno',
      'contactnumber',
      'primaryphone',
    ],
    hint: 'Indian mobile numbers; +91, 0 and spaces are fine',
  },
  {
    field: 'alternatePhone',
    label: 'Alternate phone',
    required: false,
    headers: [
      'alternatephone',
      'alternatemobile',
      'alternatenumber',
      'altphone',
      'phone2',
      'mobile2',
    ],
  },
  {
    field: 'email',
    label: 'Email',
    required: false,
    headers: ['email', 'emailid', 'emailaddress'],
  },
  {
    field: 'source',
    label: 'Source',
    required: false,
    headers: ['source', 'leadsource'],
    // An unknown name is reported as a row problem (SOURCE_UNKNOWN), never silently replaced.
    hint: 'Must match an active lead source name (Lead sources settings; case and extra spaces are ignored); rows with an unknown name are reported as problems. Blank cells use the default source',
  },
  { field: 'campaign', label: 'Campaign', required: false, headers: ['campaign', 'campaignname'] },
  {
    field: 'transactionType',
    label: 'Transaction',
    required: false,
    headers: ['transactiontype', 'transaction', 'lookingfor', 'requirementtype'],
    hint: 'Buy, Rent, Lease (commercial), Sell, Let out',
  },
  {
    field: 'propertyType',
    label: 'Property type',
    required: false,
    headers: ['propertytype', 'property', 'unittype'],
    hint: 'Apartment/Flat, Villa, Plot, Row house, Office, Shop, Warehouse, Other',
  },
  { field: 'bhkMin', label: 'BHK (min)', required: false, headers: ['bhk', 'bhkmin', 'minbhk'] },
  { field: 'bhkMax', label: 'BHK (max)', required: false, headers: ['bhkmax', 'maxbhk'] },
  {
    field: 'budgetMin',
    label: 'Budget (min)',
    required: false,
    headers: ['budget', 'budgetmin', 'minbudget', 'budgetfrom'],
    hint: '"85 L", "1.2 Cr", "85,00,000"',
  },
  {
    field: 'budgetMax',
    label: 'Budget (max)',
    required: false,
    headers: ['budgetmax', 'maxbudget', 'budgetto'],
  },
  { field: 'preferredCity', label: 'City', required: false, headers: ['city', 'preferredcity'] },
  {
    field: 'preferredLocalities',
    label: 'Localities',
    required: false,
    headers: ['locality', 'localities', 'area', 'location', 'preferredlocation'],
    hint: 'Comma-separated, up to 20',
  },
  { field: 'purpose', label: 'Purpose', required: false, headers: ['purpose'] },
  { field: 'timeline', label: 'Timeline', required: false, headers: ['timeline', 'timeframe'] },
  { field: 'intent', label: 'Intent', required: false, headers: ['intent', 'temperature'] },
  {
    field: 'preferredLanguage',
    label: 'Language',
    required: false,
    headers: ['language', 'preferredlanguage'],
  },
  {
    field: 'preferredContactMethod',
    label: 'Contact method',
    required: false,
    headers: ['contactmethod', 'preferredcontactmethod'],
  },
  {
    field: 'note',
    label: 'Notes / enquiry details',
    required: false,
    headers: ['note', 'notes', 'remarks', 'comments', 'comment', 'message', 'enquirydetails'],
    hint: 'Saved as the first note on the lead',
  },
];

export const FIELD_SPEC = new Map(IMPORT_FIELDS.map((f) => [f.field, f]));

/** A custom field as a mapping target: "custom:<key>". */
export type CustomMappingKey = `custom:${string}`;
export type MappingKey = ImportField | CustomMappingKey;
export const CUSTOM_PREFIX = 'custom:';
export const customKeyOf = (k: string): string | null =>
  k.startsWith(CUSTOM_PREFIX) ? k.slice(CUSTOM_PREFIX.length) : null;

/** An active custom field offered for mapping. */
export interface CustomMappingField {
  key: string;
  label: string;
  required: boolean;
}

/** Column index (0-based) for each mapped field. Unmapped fields are absent. */
export type ColumnMapping = Partial<Record<MappingKey, number>>;

export const normaliseHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export type HeaderIssueCode =
  'HEADER_MISSING' | 'HEADER_EMPTY' | 'HEADER_DUPLICATE' | 'HEADER_TOO_LONG' | 'TOO_MANY_COLUMNS';

export interface HeaderIssue {
  code: HeaderIssueCode;
  /** 0-based column, when the issue is about one column. */
  column?: number;
}

/** Header checks. Empty and duplicate headers are warnings: such columns can stay unmapped. */
export function checkHeaders(
  headers: readonly string[],
  limits: { maxColumns: number; maxHeaderChars: number },
): { fatal: HeaderIssue[]; warnings: HeaderIssue[] } {
  const fatal: HeaderIssue[] = [];
  const warnings: HeaderIssue[] = [];
  if (headers.length === 0 || headers.every((h) => !h.trim()))
    fatal.push({ code: 'HEADER_MISSING' });
  if (headers.length > limits.maxColumns) fatal.push({ code: 'TOO_MANY_COLUMNS' });
  const seen = new Map<string, number>();
  headers.forEach((h, column) => {
    if (h.length > limits.maxHeaderChars) fatal.push({ code: 'HEADER_TOO_LONG', column });
    const n = normaliseHeader(h);
    if (!n) warnings.push({ code: 'HEADER_EMPTY', column });
    else if (seen.has(n)) warnings.push({ code: 'HEADER_DUPLICATE', column });
    else seen.set(n, column);
  });
  return { fatal, warnings };
}

/**
 * Suggests a mapping from header names (FR-041). A field is suggested only from its first
 * matching column; a column whose header is duplicated is never suggested (ambiguous).
 */
export function suggestMapping(
  headers: readonly string[],
  custom: readonly CustomMappingField[] = [],
): ColumnMapping {
  const counts = new Map<string, number>();
  for (const h of headers)
    counts.set(normaliseHeader(h), (counts.get(normaliseHeader(h)) ?? 0) + 1);
  const mapping: ColumnMapping = {};
  for (const spec of IMPORT_FIELDS) {
    for (const alias of spec.headers) {
      const column = headers.findIndex((h) => normaliseHeader(h) === alias);
      if (column >= 0 && counts.get(alias) === 1 && !Object.values(mapping).includes(column)) {
        mapping[spec.field] = column;
        break;
      }
    }
  }
  // Custom fields: a header equal to the field's label or key (normalised), when unambiguous.
  for (const c of custom) {
    for (const alias of [normaliseHeader(c.label), normaliseHeader(c.key)]) {
      const column = headers.findIndex((h) => normaliseHeader(h) === alias);
      if (column >= 0 && counts.get(alias) === 1 && !Object.values(mapping).includes(column)) {
        mapping[`${CUSTOM_PREFIX}${c.key}`] = column;
        break;
      }
    }
  }
  return mapping;
}

export type MappingIssueCode =
  'FIELD_UNKNOWN' | 'COLUMN_INVALID' | 'COLUMN_MAPPED_TWICE' | 'REQUIRED_UNMAPPED';

export interface MappingIssue {
  code: MappingIssueCode;
  field?: string;
  column?: number;
}

/** Parses an untrusted mapping (from a form) against the file's header count. */
export function validateMapping(
  raw: Record<string, unknown>,
  columnCount: number,
  custom: readonly CustomMappingField[] = [],
): { ok: true; mapping: ColumnMapping } | { ok: false; issues: MappingIssue[] } {
  const customByKey = new Map(custom.map((c) => [c.key, c]));
  const issues: MappingIssue[] = [];
  const mapping: ColumnMapping = {};
  const used = new Map<number, string>();
  for (const [field, value] of Object.entries(raw)) {
    if (value === '' || value === null || value === undefined) continue;
    const customKey = customKeyOf(field);
    const spec = customKey === null ? FIELD_SPEC.get(field as ImportField) : undefined;
    // Only the org's active custom fields can be mapped (unknown or archived keys are refused).
    if (!spec && !(customKey !== null && customByKey.has(customKey))) {
      issues.push({ code: 'FIELD_UNKNOWN', field });
      continue;
    }
    const column = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(column) || column < 0 || column >= columnCount) {
      issues.push({ code: 'COLUMN_INVALID', field });
      continue;
    }
    if (used.has(column)) {
      issues.push({ code: 'COLUMN_MAPPED_TWICE', field, column });
      continue;
    }
    used.set(column, field);
    mapping[spec ? spec.field : (field as CustomMappingKey)] = column;
  }
  for (const spec of IMPORT_FIELDS)
    if (spec.required && mapping[spec.field] === undefined)
      issues.push({ code: 'REQUIRED_UNMAPPED', field: spec.field });
  for (const c of custom)
    if (c.required && mapping[`${CUSTOM_PREFIX}${c.key}`] === undefined)
      issues.push({ code: 'REQUIRED_UNMAPPED', field: `${CUSTOM_PREFIX}${c.key}` });
  return issues.length ? { ok: false, issues } : { ok: true, mapping };
}

/** Columns the mapping leaves out (shown to the user; their data is not imported). */
export function unmappedColumns(columnCount: number, mapping: ColumnMapping): number[] {
  const used = new Set(Object.values(mapping));
  return Array.from({ length: columnCount }, (_, i) => i).filter((i) => !used.has(i));
}
