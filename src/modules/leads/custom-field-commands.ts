// Custom lead fields (FR-064; owner decision D5): definition management (Owner/Admin,
// org.settings.manage) and per-lead values (lead.update in scope). Validation lives in
// custom-fields.ts; migration 0006 enforces the same limits in the database (at most 30 active
// per org under an advisory lock, key/type never updatable, keys never reused, option CHECKs,
// values object <= 16 KB).
//
// - Values are never coerced: a number field takes a JSON number, a date an ISO date string, etc.
//   Unknown and archived keys are refused, as is clearing a required field.
// - Values of an archived field stay stored (and visible) but accept no new value.
// - An option still used by a lead cannot be removed (stored values would silently turn invalid).
// - Value writes lock the org's definitions FOR SHARE, so a concurrent archive / option change
//   cannot slip between validation and the write.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { conflict, notFound, ruleViolation } from '@/platform/errors';
import {
  assertWritable,
  findInScope,
  invalid,
  parseId,
  staleVersion,
  WRITABLE_FIELDS,
} from './access';
import {
  applyCustomFieldChanges,
  customFieldDefinitionInput,
  customFieldsSchema,
  MAX_ACTIVE_CUSTOM_FIELDS,
  MAX_OPTIONS,
  MAX_VALUES_BYTES,
  type CustomFieldDefinition,
  type CustomFieldType,
} from './custom-fields';

export interface CustomField extends CustomFieldDefinition {
  id: string;
  position: number;
  version: number;
  archivedAt: Date | null;
}

const SELECT = {
  id: true,
  key: true,
  label: true,
  type: true,
  required: true,
  options: true,
  position: true,
  version: true,
  archivedAt: true,
} as const;

function toField(r: {
  id: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: unknown;
  position: number;
  version: number;
  archivedAt: Date | null;
}): CustomField {
  const options = r.options as string[];
  return {
    id: r.id,
    key: r.key,
    label: r.label,
    type: r.type as CustomFieldType,
    required: r.required,
    ...(options.length ? { options } : {}),
    position: r.position,
    version: r.version,
    archivedAt: r.archivedAt,
    archived: r.archivedAt !== null,
  };
}

/** Database refusals with a user-facing meaning (the database is the authority). */
function mapDbError(e: unknown): never {
  const msg = e instanceof Error ? e.message : '';
  if (/at most 30 active custom fields/.test(msg))
    throw ruleViolation(
      `An organisation can have at most ${MAX_ACTIVE_CUSTOM_FIELDS} active custom fields`,
    );
  if (
    /custom_field_definition_org_id_key_key/.test(msg) ||
    (/Unique constraint/i.test(msg) && /key/.test(msg))
  )
    throw conflict('This key is already used by a custom field (keys are never reused)');
  throw e;
}

const listInput = z.object({ includeArchived: z.boolean().default(false) });

export async function listCustomFields(
  ctx: RequestContext,
  raw: unknown = {},
): Promise<CustomField[]> {
  authorize(ctx, 'lead.read');
  const { includeArchived } = listInput.parse(raw);
  return tenantRunner().withTenant(ctx.tenant, async (tx) =>
    (
      await tx.customFieldDefinition.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: SELECT,
      })
    ).map(toField),
  );
}

export async function createCustomField(
  ctx: RequestContext,
  raw: unknown,
): Promise<{ id: string }> {
  authorize(ctx, 'org.settings.manage');
  const input = customFieldDefinitionInput.parse(raw);
  try {
    return await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const last = await tx.customFieldDefinition.aggregate({ _max: { position: true } });
      const row = await tx.customFieldDefinition.create({
        data: {
          orgId: ctx.orgId,
          key: input.key,
          label: input.label,
          type: input.type,
          required: input.required,
          options: input.options ?? [],
          position: Math.min((last._max.position ?? -1) + 1, 1000),
          createdBy: ctx.userId,
        },
        select: { id: true },
      });
      await writeAudit(tx, ctx.orgId, {
        action: 'custom_field.created',
        entityType: 'custom_field_definition',
        entityId: row.id,
        actorUserId: ctx.userId,
        metadata: { key: input.key, type: input.type, required: input.required },
      });
      return row;
    });
  } catch (e) {
    mapDbError(e);
  }
}

const updateInput = z
  .object({
    version: z.coerce.number().int().min(1),
    label: z.string().trim().min(1).max(100).optional(),
    required: z.boolean().optional(),
    options: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_OPTIONS).optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .strict(); // key and type are immutable: they are not accepted at all

/** Label, required flag, options (select fields) and position. Key and type never change. */
export async function updateCustomField(
  ctx: RequestContext,
  fieldId: string,
  raw: unknown,
): Promise<void> {
  authorize(ctx, 'org.settings.manage');
  const id = parseId(fieldId, 'Custom field');
  const input = updateInput.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const f = await tx.customFieldDefinition.findFirst({ where: { id }, select: SELECT });
    if (!f) throw notFound('Custom field not found');
    if (f.version !== input.version) throw staleVersion();
    const field = toField(f);
    let options: string[] | undefined;
    if (input.options) {
      if (field.type !== 'single_select' && field.type !== 'multi_select')
        throw invalid({ options: ['Only select fields have options'] });
      if (new Set(input.options.map((o) => o.toLowerCase())).size !== input.options.length)
        throw invalid({ options: ['Options must be unique'] });
      const removed = (field.options ?? []).filter((o) => !input.options!.includes(o));
      if (removed.length && (await leadsUsing(tx, field, removed)) > 0)
        throw ruleViolation(
          'An option you removed is still used by leads; change those leads first',
        );
      options = input.options;
    }
    const n = await tx.customFieldDefinition.updateMany({
      where: { id, version: input.version },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.required !== undefined ? { required: input.required } : {}),
        ...(options ? { options } : {}),
        ...(input.position !== undefined ? { position: input.position } : {}),
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    if (n.count !== 1) throw staleVersion();
    await writeAudit(tx, ctx.orgId, {
      action: 'custom_field.updated',
      entityType: 'custom_field_definition',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: {
        key: field.key,
        changed: Object.keys(input)
          .filter((k) => k !== 'version')
          .join(','),
      },
    });
  });
}

/** Leads whose stored value for `field` uses one of `options` (RLS: this org only). */
async function leadsUsing(tx: Tx, field: CustomField, options: string[]): Promise<number> {
  const [r] =
    field.type === 'multi_select'
      ? await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM lead WHERE custom_fields -> ${field.key} ?| ${options}::text[]`
      : await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM lead WHERE custom_fields ->> ${field.key} = ANY(${options}::text[])`;
  return r?.n ?? 0;
}

const versionOnly = z.object({ version: z.coerce.number().int().min(1) });

/** Archive (stored values kept, no new values) or restore (the 30-active limit applies). */
export async function setCustomFieldArchived(
  ctx: RequestContext,
  fieldId: string,
  archived: boolean,
  raw: unknown,
): Promise<void> {
  authorize(ctx, 'org.settings.manage');
  const id = parseId(fieldId, 'Custom field');
  const { version } = versionOnly.parse(raw);
  try {
    await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const f = await tx.customFieldDefinition.findFirst({ where: { id }, select: SELECT });
      if (!f) throw notFound('Custom field not found');
      if ((f.archivedAt !== null) === archived)
        throw conflict(archived ? 'This field is already archived' : 'This field is not archived');
      if (f.version !== version) throw staleVersion();
      const n = await tx.customFieldDefinition.updateMany({
        where: { id, version },
        data: {
          archivedAt: archived ? new Date() : null,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (n.count !== 1) throw staleVersion();
      await writeAudit(tx, ctx.orgId, {
        action: archived ? 'custom_field.archived' : 'custom_field.restored',
        entityType: 'custom_field_definition',
        entityId: id,
        actorUserId: ctx.userId,
        metadata: { key: f.key },
      });
    });
  } catch (e) {
    mapDbError(e);
  }
}

// ---------------------------------------------------------------------------------------------
// Values

/** The org's definitions, locked FOR SHARE until the caller's transaction ends. */
export async function lockedDefinitions(tx: Tx): Promise<CustomField[]> {
  await tx.$queryRaw`SELECT id FROM custom_field_definition ORDER BY id FOR SHARE`;
  return (
    await tx.customFieldDefinition.findMany({ orderBy: { position: 'asc' }, select: SELECT })
  ).map(toField);
}

/**
 * Validates `values` against already-loaded definitions (strict: unknown or archived keys, wrong
 * types and missing required fields are refused with field errors keyed `customFields.<key>`).
 */
export function checkCustomValues(
  defs: readonly CustomField[],
  values: unknown,
  opts: { requireRequired: boolean },
): Record<string, unknown> {
  const parsed = customFieldsSchema(defs, opts).safeParse(values ?? {});
  if (!parsed.success) {
    const errors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const keys =
        issue.code === 'unrecognized_keys' ? issue.keys : [String(issue.path[0] ?? 'customFields')];
      for (const k of keys)
        (errors[`customFields.${k}`] ??= []).push(
          issue.code === 'unrecognized_keys' ? 'Unknown or archived custom field' : issue.message,
        );
    }
    throw invalid(errors);
  }
  if (!opts.requireRequired) {
    const cleared = defs.filter(
      (d) => !d.archived && d.required && (parsed.data as Record<string, unknown>)[d.key] === null,
    );
    if (cleared.length)
      throw invalid(
        Object.fromEntries(
          cleared.map((d) => [`customFields.${d.key}`, ['This field is required']]),
        ),
      );
  }
  return parsed.data as Record<string, unknown>;
}

/** checkCustomValues with the org's definitions locked FOR SHARE inside `tx`. */
export async function validateCustomValues(
  tx: Tx,
  values: unknown,
  opts: { requireRequired: boolean },
): Promise<Record<string, unknown>> {
  return checkCustomValues(await lockedDefinitions(tx), values, opts);
}

const valuesInput = z.object({
  version: z.coerce.number().int().min(1),
  values: z.record(z.string(), z.unknown()),
});

/** Sets (or, with null, clears) custom values on one lead. Other stored values are kept. */
export async function setLeadCustomFields(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<void> {
  const scope = authorize(ctx, 'lead.update');
  const id = parseId(leadId);
  const input = valuesInput.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const lead = await findInScope(tx, ctx, scope, id, {
      version: true,
      customFields: true,
      ...WRITABLE_FIELDS,
    });
    assertWritable(lead);
    if (lead.version !== input.version) throw staleVersion();
    const changes = await validateCustomValues(tx, input.values, { requireRequired: false });
    const next = applyCustomFieldChanges(lead.customFields as Record<string, unknown>, changes);
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_VALUES_BYTES)
      throw invalid({ customFields: ['Custom field values are too large'] });
    const changed = Object.keys(changes);
    if (!changed.length) return;
    const n = await tx.lead.updateMany({
      where: { id, version: input.version },
      data: { customFields: next as object, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (n.count !== 1) throw staleVersion();
    await tx.leadActivity.create({
      data: {
        orgId: ctx.orgId,
        leadId: id,
        type: 'FIELD_CHANGED',
        actorId: ctx.userId,
        summary: { customFields: changed },
      },
    });
  });
}
