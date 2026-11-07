// Saved import mapping templates (FR-041: "saved mapping templates per source"; migration 0009).
// Owner/Admin (lead.import) save a validated mapping under a name, optionally for a lead source,
// and apply it to a later file of the same format.
//
// - A template stores field -> column-heading TEXT, never a column position or a cell value.
//   Applying it matches headings again (normaliseHeader, as for suggestions): a heading that is
//   missing from the new file, or appears more than once, leaves that field unmapped with a
//   warning; a field that no longer exists (an archived custom field) is dropped with a warning.
//   Nothing is ever mapped by position, so a reordered file still maps correctly and a different
//   file cannot silently map a column to the wrong field.
// - Applying only pre-fills the mapping form. submitMapping still validates the mapping (required
//   fields, duplicates, active custom fields) exactly as for a manual mapping.
// - Names are normalized (trimmed, inner whitespace collapsed); one name per org ignoring case.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { normalizeSourceName, sourceKey } from '@/modules/leads';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { conflict, DomainError, notFound, ruleViolation } from '@/platform/errors';
import {
  CUSTOM_PREFIX,
  customKeyOf,
  FIELD_SPEC,
  IMPORT_FIELDS,
  normaliseHeader,
  type ColumnMapping,
  type CustomMappingField,
  type ImportField,
} from './mapping';

/** field -> column heading text, as stored. */
export type TemplateMapping = Record<string, string>;

export type TemplateWarningCode =
  | 'HEADER_MISSING'
  | 'HEADER_AMBIGUOUS'
  | 'HEADER_ALREADY_USED'
  | 'FIELD_UNKNOWN'
  | 'REQUIRED_UNMAPPED';

export interface TemplateWarning {
  code: TemplateWarningCode;
  field: string;
  header?: string;
}

export const TEMPLATE_WARNING_MESSAGES: Record<TemplateWarningCode, string> = {
  HEADER_MISSING: 'This file has no column with this heading; choose the column yourself.',
  HEADER_AMBIGUOUS: 'This file has several columns with this heading; choose the right one.',
  HEADER_ALREADY_USED: 'This heading is already used by another field in the template.',
  FIELD_UNKNOWN:
    'This field no longer exists (for example an archived custom field); it was skipped.',
  REQUIRED_UNMAPPED: 'Required: choose a column before validating.',
};

const MAX_TEMPLATE_FIELDS = 100;
const MAX_HEADER_CHARS = 200;

/** The template form of a submitted mapping: each mapped field with its column's heading. */
export function templateFromMapping(
  headers: readonly string[],
  mapping: ColumnMapping | Record<string, unknown>,
): TemplateMapping {
  const out: TemplateMapping = {};
  for (const [field, column] of Object.entries(mapping)) {
    if (typeof column !== 'number' || !Number.isInteger(column)) continue;
    const header = (headers[column] ?? '').trim();
    if (header) out[field] = header.slice(0, MAX_HEADER_CHARS);
  }
  return out;
}

/**
 * Pure: a stored template applied to a file's headings. Fields map only to a column whose
 * heading matches exactly once; everything else is reported, never guessed.
 */
export function applyTemplate(
  template: TemplateMapping,
  headers: readonly string[],
  custom: readonly CustomMappingField[] = [],
): { mapping: ColumnMapping; warnings: TemplateWarning[] } {
  const customKeys = new Set(custom.map((c) => c.key));
  const byHeading = new Map<string, number[]>();
  headers.forEach((h, i) => {
    const k = normaliseHeader(h);
    if (k) byHeading.set(k, [...(byHeading.get(k) ?? []), i]);
  });
  const mapping: ColumnMapping = {};
  const warnings: TemplateWarning[] = [];
  const used = new Set<number>();
  for (const [field, header] of Object.entries(template)) {
    const customKey = customKeyOf(field);
    const known =
      customKey === null ? FIELD_SPEC.has(field as ImportField) : customKeys.has(customKey);
    if (!known) {
      warnings.push({ code: 'FIELD_UNKNOWN', field, header });
      continue;
    }
    const columns = byHeading.get(normaliseHeader(header)) ?? [];
    if (columns.length === 0) warnings.push({ code: 'HEADER_MISSING', field, header });
    else if (columns.length > 1) warnings.push({ code: 'HEADER_AMBIGUOUS', field, header });
    else if (used.has(columns[0]!)) warnings.push({ code: 'HEADER_ALREADY_USED', field, header });
    else {
      used.add(columns[0]!);
      mapping[field as keyof ColumnMapping] = columns[0]!;
    }
  }
  for (const spec of IMPORT_FIELDS)
    if (spec.required && mapping[spec.field] === undefined)
      warnings.push({ code: 'REQUIRED_UNMAPPED', field: spec.field });
  for (const c of custom)
    if (c.required && mapping[`${CUSTOM_PREFIX}${c.key}`] === undefined)
      warnings.push({ code: 'REQUIRED_UNMAPPED', field: `${CUSTOM_PREFIX}${c.key}` });
  return { mapping, warnings };
}

export interface MappingTemplateView {
  id: string;
  name: string;
  sourceId: string | null;
  sourceName: string | null;
  fieldCount: number;
  createdAt: Date;
}

export async function listMappingTemplates(ctx: RequestContext): Promise<MappingTemplateView[]> {
  authorize(ctx, 'lead.import');
  return tenantRunner().withTenant(ctx.tenant, async (tx) =>
    (
      await tx.importMappingTemplate.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          sourceId: true,
          mapping: true,
          createdAt: true,
          source: { select: { name: true } },
        },
      })
    ).map((t) => ({
      id: t.id,
      name: t.name,
      sourceId: t.sourceId,
      sourceName: t.source?.name ?? null,
      fieldCount: Object.keys(t.mapping as object).length,
      createdAt: t.createdAt,
    })),
  );
}

const optionalId = z.union([z.uuid(), z.literal('')]).optional();
const saveInput = z.object({
  importId: z.uuid(),
  name: z
    .string()
    .transform(normalizeSourceName)
    .pipe(z.string().min(1, 'Enter a name').max(100, 'At most 100 characters')),
  sourceId: optionalId,
});

/**
 * Statuses whose mapping passed validation. Anything else (still validating, sent back to mapping,
 * failed, cancelled, expired) has no reviewed mapping to save, whatever the page shows.
 */
const SAVABLE_STATUSES = new Set([
  'READY',
  'IMPORTING',
  'PAUSED',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
]);

const duplicateName = (name: string) =>
  conflict(`A mapping template named "${name}" already exists (names ignore case and spacing)`);

/** Saves the mapping of an import (already submitted and validated) as a named template. */
export async function saveMappingTemplate(
  ctx: RequestContext,
  raw: unknown,
): Promise<{ id: string }> {
  authorize(ctx, 'lead.import');
  const input = saveInput.parse(raw);
  try {
    return await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const job = await tx.importJob.findFirst({
        where: { id: input.importId },
        select: { headers: true, mapping: true, status: true },
      });
      if (!job) throw notFound('Import not found');
      if (!job.mapping || !SAVABLE_STATUSES.has(job.status))
        throw ruleViolation('Validate the mapping first, then save it as a template');
      const mapping = templateFromMapping(job.headers, job.mapping as Record<string, unknown>);
      const count = Object.keys(mapping).length;
      if (count === 0 || count > MAX_TEMPLATE_FIELDS)
        throw ruleViolation('This mapping has no columns to save');
      let sourceId: string | null = null;
      if (input.sourceId) {
        const s = await tx.leadSource.findFirst({
          where: { id: input.sourceId, isActive: true },
          select: { id: true },
        });
        if (!s) throw new DomainError('VALIDATION_FAILED', 'Choose an active lead source');
        sourceId = s.id;
      }
      const key = sourceKey(input.name);
      const clash = (await tx.importMappingTemplate.findMany({ select: { name: true } })).find(
        (t) => sourceKey(t.name) === key,
      );
      if (clash) throw duplicateName(clash.name);
      const row = await tx.importMappingTemplate.create({
        data: { orgId: ctx.orgId, name: input.name, sourceId, mapping, createdBy: ctx.userId },
        select: { id: true },
      });
      await writeAudit(tx, ctx.orgId, {
        action: 'import_template.created',
        entityType: 'import_mapping_template',
        entityId: row.id,
        actorUserId: ctx.userId,
        metadata: { name: input.name, fields: count, sourceId },
      });
      return row;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (/import_mapping_template_org_name_uq|Unique constraint/i.test(msg))
      throw duplicateName(input.name);
    throw e;
  }
}

export async function deleteMappingTemplate(ctx: RequestContext, rawId: unknown): Promise<void> {
  authorize(ctx, 'lead.import');
  const id = z.uuid().safeParse(rawId);
  if (!id.success) throw notFound('Template not found');
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const t = await tx.importMappingTemplate.findFirst({
      where: { id: id.data },
      select: { name: true },
    });
    if (!t) throw notFound('Template not found');
    await tx.importMappingTemplate.delete({ where: { id: id.data } });
    await writeAudit(tx, ctx.orgId, {
      action: 'import_template.deleted',
      entityType: 'import_mapping_template',
      entityId: id.data,
      actorUserId: ctx.userId,
      metadata: { name: t.name },
    });
  });
}

/**
 * A template applied to an import's headings, for pre-filling the mapping form. Reads only; the
 * mapping is saved and validated by submitMapping as usual. The template's source is offered as
 * the default source only while it is active.
 */
export async function templateForImport(
  ctx: RequestContext,
  rawImportId: unknown,
  rawTemplateId: unknown,
): Promise<{
  name: string;
  mapping: ColumnMapping;
  warnings: TemplateWarning[];
  sourceId: string | null;
}> {
  authorize(ctx, 'lead.import');
  const importId = z.uuid().safeParse(rawImportId);
  const templateId = z.uuid().safeParse(rawTemplateId);
  if (!importId.success) throw notFound('Import not found');
  if (!templateId.success) throw notFound('Template not found');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const job = await tx.importJob.findFirst({
      where: { id: importId.data },
      select: { headers: true },
    });
    if (!job) throw notFound('Import not found');
    const t = await tx.importMappingTemplate.findFirst({
      where: { id: templateId.data },
      select: { name: true, mapping: true, source: { select: { id: true, isActive: true } } },
    });
    if (!t) throw notFound('Template not found');
    // The org's ACTIVE custom fields, as submitMapping checks them.
    const custom = await tx.customFieldDefinition.findMany({
      where: { archivedAt: null },
      select: { key: true, label: true, required: true },
    });
    const applied = applyTemplate(t.mapping as TemplateMapping, job.headers, custom);
    return {
      name: t.name,
      ...applied,
      sourceId: t.source?.isActive ? t.source.id : null,
    };
  });
}
