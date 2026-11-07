// Leads module: input vocabularies, schemas and normalisation of a new lead's fields. Pure (no
// database), shared by manual create, requirement edits and import row validation (Phase 2 M4).
import { z } from 'zod';
import { normaliseIndianPhone, parseBudgetInr, type NormalisedPhone } from './normalise';

// ---------------------------------------------------------------------------------------------
// Field vocabularies (lead-lifecycle §4)

export const TRANSACTION_TYPES = ['BUY', 'RENT', 'LEASE_COMMERCIAL', 'SELL', 'LET_OUT'] as const;
export const PROPERTY_TYPES = [
  'APARTMENT',
  'VILLA',
  'PLOT',
  'ROW_HOUSE',
  'OFFICE',
  'SHOP',
  'WAREHOUSE',
  'OTHER',
] as const;
export const CONTACT_METHODS = ['PHONE', 'WHATSAPP', 'EMAIL', 'ANY'] as const;
export const PURPOSES = ['SELF_USE', 'INVESTMENT', 'UNKNOWN'] as const;
export const TIMELINES = ['IMMEDIATE', 'WITHIN_1M', '1_3M', '3_6M', '6M_PLUS', 'UNKNOWN'] as const;
export const INTENTS = ['HOT', 'WARM', 'COLD'] as const;

// ---------------------------------------------------------------------------------------------
// Input parsing. Blank form values mean "not given".

export const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
export const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());
export const text = (max: number) => z.string().trim().max(max);

const requirementsShape = {
  transactionType: opt(z.enum(TRANSACTION_TYPES)),
  propertyType: opt(z.enum(PROPERTY_TYPES)),
  bhkMin: opt(z.coerce.number().int().min(0).max(20)),
  bhkMax: opt(z.coerce.number().int().min(0).max(20)),
  budgetMin: opt(z.string()),
  budgetMax: opt(z.string()),
  preferredCity: opt(text(100)),
  preferredLocalities: opt(z.string().max(2000)),
  purpose: opt(z.enum(PURPOSES)),
  timeline: opt(z.enum(TIMELINES)),
  intent: opt(z.enum(INTENTS)),
};

export const createInput = z.object({
  fullName: z.string().trim().min(1, 'Enter the customer name').max(200),
  primaryPhone: z.string().max(64),
  alternatePhone: opt(z.string().max(64)),
  email: opt(z.email().max(254)),
  preferredLanguage: opt(z.string().regex(/^[a-z]{2}$/, 'Use a two-letter language code')),
  preferredContactMethod: opt(z.enum(CONTACT_METHODS)),
  sourceId: opt(z.uuid()),
  campaign: opt(text(200)),
  note: opt(text(5000)),
  ...requirementsShape,
});

/** The requirement fields a person can edit (FR-058; the outcome sheet's patch, FR-084). */
export const REQUIREMENT_FIELDS = [
  'transactionType',
  'propertyType',
  'bhkMin',
  'bhkMax',
  'budgetMin',
  'budgetMax',
  'preferredCity',
  'preferredLocalities',
  'purpose',
  'timeline',
  'intent',
] as const;
export type RequirementField = (typeof REQUIREMENT_FIELDS)[number];

export const requirementsInput = z.object({
  version: z.coerce.number().int().min(1),
  ...requirementsShape,
});

type RequirementsRaw = z.infer<z.ZodObject<typeof requirementsShape>>;

export interface Requirements {
  transactionType: string | null;
  propertyType: string | null;
  bhkMin: number | null;
  bhkMax: number | null;
  budgetMin: string | null;
  budgetMax: string | null;
  preferredCity: string | null;
  preferredLocalities: string[];
  purpose: string | null;
  timeline: string | null;
  intent: string | null;
}

/** One rejected field, with a machine code for import row reports (FR-042). */
export interface FieldIssue {
  field: string;
  code: string;
  message: string;
}

/** `{ field: [messages] }` for forms and DomainError. */
export function fieldErrors(issues: FieldIssue[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const i of issues) (out[i.field] ??= []).push(i.message);
  return out;
}

/** Budgets go through the M0 parser; ranges are cross-checked (DB CHECKs mirror these). */
export function toRequirements(r: RequirementsRaw, issues: FieldIssue[]): Requirements {
  const budget = (key: 'budgetMin' | 'budgetMax') => {
    const res = parseBudgetInr(r[key]);
    if (!res.ok) {
      issues.push({ field: key, code: res.code, message: res.message });
      return null;
    }
    return res.value;
  };
  const budgetMin = budget('budgetMin');
  const budgetMax = budget('budgetMax');
  if (budgetMin && budgetMax && Number(budgetMin) > Number(budgetMax))
    issues.push({
      field: 'budgetMax',
      code: 'BUDGET_MIN_ABOVE_MAX',
      message: 'Maximum budget must not be below the minimum',
    });
  if (r.bhkMin != null && r.bhkMax != null && r.bhkMin > r.bhkMax)
    issues.push({
      field: 'bhkMax',
      code: 'BHK_MIN_ABOVE_MAX',
      message: 'Maximum BHK must not be below the minimum',
    });
  const localities = [
    ...new Set(
      (r.preferredLocalities ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (localities.length > 20 || localities.some((l) => l.length > 100))
    issues.push({
      field: 'preferredLocalities',
      code: 'LOCALITIES_LIMIT',
      message: 'Up to 20 localities, each up to 100 characters',
    });
  return {
    transactionType: r.transactionType ?? null,
    propertyType: r.propertyType ?? null,
    bhkMin: r.bhkMin ?? null,
    bhkMax: r.bhkMax ?? null,
    budgetMin,
    budgetMax,
    preferredCity: r.preferredCity ?? null,
    preferredLocalities: localities,
    purpose: r.purpose ?? null,
    timeline: r.timeline ?? null,
    intent: r.intent ?? null,
  };
}

export type CreateInput = z.infer<typeof createInput>;

/** A new lead's fields after normalisation: what createLead and the importer write. */
export interface PreparedLead {
  input: CreateInput;
  primary: NormalisedPhone;
  alternate: NormalisedPhone | null;
  requirements: Requirements;
  /** Primary first; the duplicate-match and lock keys. */
  phones: string[];
}

/**
 * Normalises phones (M0) and requirements and applies the cross-field rules. Pure: shared by
 * manual create (FR-055) and import row validation (FR-042), so both accept exactly the same
 * leads.
 */
export function prepareLead(
  input: CreateInput,
): { ok: true; lead: PreparedLead } | { ok: false; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const primary = normaliseIndianPhone(input.primaryPhone);
  if (!primary.ok)
    issues.push({ field: 'primaryPhone', code: primary.code, message: primary.message });
  else if (!primary.value)
    issues.push({
      field: 'primaryPhone',
      code: 'PHONE_REQUIRED',
      message: 'Enter the customer phone number',
    });
  const alternate = normaliseIndianPhone(input.alternatePhone);
  if (!alternate.ok)
    issues.push({ field: 'alternatePhone', code: alternate.code, message: alternate.message });
  const requirements = toRequirements(input, issues);
  const primaryValue = primary.ok ? primary.value : null;
  const alternateValue = alternate.ok ? alternate.value : null;
  if (primaryValue && alternateValue?.e164 === primaryValue.e164)
    issues.push({
      field: 'alternatePhone',
      code: 'ALTERNATE_SAME_AS_PRIMARY',
      message: 'Alternate phone must differ from the primary phone',
    });
  if (issues.length || !primaryValue) return { ok: false, issues };
  return {
    ok: true,
    lead: {
      input,
      primary: primaryValue,
      alternate: alternateValue,
      requirements,
      phones: [primaryValue.e164, ...(alternateValue ? [alternateValue.e164] : [])],
    },
  };
}
