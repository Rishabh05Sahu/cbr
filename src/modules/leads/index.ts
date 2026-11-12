// Leads module (Phase 2 M1–M2): manual create with duplicate check, the lead list with search,
// filters and cursor pagination, lead detail, requirement edits, stage changes, notes and the
// activity timeline (FR-032, FR-055–FR-059).
//
// Every function authorises first, then reads and writes inside withTenant(), so RLS limits
// rows to the caller's org. Own/team visibility (user-personas-and-roles §2.2) is applied here
// as a query filter: a lead outside the caller's scope is reported as not found, exactly like
// a lead in another org. Actor, org and timestamps always come from the server context.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, can, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Prisma, type Tx } from '@/platform/db';
import { emitEvent } from '@/platform/outbox';
import { conflict, notFound, ruleViolation } from '@/platform/errors';
import { canAssignLead } from './assignment';
import {
  assertWritable,
  canonicalLeadId,
  cleanText,
  ensureUnknownSource,
  findInScope,
  findOpenMatch,
  historyLeadIds,
  invalid,
  isOpenPhoneConflict,
  lockPhones,
  OPEN,
  parseId,
  primaryTeamId,
  scopeFilter,
  staleVersion,
  WRITABLE_FIELDS,
} from './access';
import { validateCustomValues } from './custom-field-commands';
import { closeFollowUpsForStage } from './follow-up-lifecycle';
import { closeVisitsForStage } from './visit-lifecycle';
import type { ContactStatus } from './contactability';
import { phoneDisplay, phoneMaskingPolicy } from './phone-masking';
import { routeEnquiryForArchivedLead } from './hygiene';
import {
  createInput,
  fieldErrors,
  opt,
  prepareLead,
  requirementsInput,
  text,
  toRequirements,
  type FieldIssue,
  type RequirementField,
  type Requirements,
} from './input';
import { normaliseIndianPhone } from './normalise';
import { filterWhere } from './list-where';
import { insertNewLead, insertNote } from './write';
import {
  decodeLeadCursor,
  encodeLeadCursor,
  LEAD_PAGE_SIZE,
  parseLeadQuery,
  type LeadCursor,
  type LeadQuery,
  type LeadSort,
  type SearchParams,
} from './list-query';
import {
  LEAD_STAGES,
  milestonesReached,
  parseOrgLocal,
  planStageChange,
  type LeadStage,
  type MilestoneField,
  type StagePlan,
} from './stages';

export {
  checkImportAssignment,
  commitImportBatch,
  IMPORT_BATCH_MAX,
  importExternalId,
  importLeadBatch,
  openLeadsByPhone,
  unknownSourceId,
  type ImportBatchOptions,
  type ImportRowInput,
  type ImportRowOutcome,
} from './importing';
export {
  CONTACT_METHODS,
  createInput,
  fieldErrors,
  INTENTS,
  prepareLead,
  PROPERTY_TYPES,
  PURPOSES,
  REQUIREMENT_FIELDS,
  requirementsInput,
  TIMELINES,
  toRequirements,
  type RequirementField,
  TRANSACTION_TYPES,
  type CreateInput,
  type FieldIssue,
  type PreparedLead,
  type Requirements,
} from './input';
export {
  allowedTargets,
  LEAD_STAGES,
  LOST_REASONS,
  planStageChange,
  STAGE_LABELS,
  type LeadStage,
} from './stages';
export {
  assignLead,
  assignmentTargets,
  bulkChangeTeam,
  bulkAssign,
  countOpenLeadsOwnedBy,
  getAssignmentHistory,
  handOverOpenLeads,
  importAssignmentSchema,
  openLeadCounts,
  roundRobinAssign,
  type AssignmentSpell,
  type AssignmentTargets,
  type ImportAssignment,
} from './assignment';
export { mergeLeads, previewMerge, type MergePreview } from './merge';
export {
  assertOutboundAllowed,
  changeContactStatus,
  contactStatusHistory,
  recordContactStatusChange,
  type ContactStatusEventView,
  type ContactStatusRequest,
} from './contact-status';
export {
  dialNumberIn,
  maskPhone,
  revealLeadPhone,
  type DialNumberKind,
  type PhoneMaskingPolicy,
  type RevealedPhone,
} from './phone-masking';
export {
  allowedContactStatusTargets,
  CONTACT_METHOD_LABELS,
  CONTACT_STATUS_LABELS,
  CONTACT_STATUSES,
  DNC_METHODS,
  LIFT_BASES,
  OUTBOUND_CHANNELS,
  outboundEligibility,
  type ContactStatus,
  type OutboundChannel,
  type OutboundEligibility,
  contactStatusChangeErrors,
} from './contactability';
export { countExportRows, loadExportRows } from './export-rows';
export {
  customCellValue,
  customFieldsSchema,
  customIssueField,
  customKeyFromIssueField,
  type CustomFieldDefinition,
} from './custom-fields';
export {
  EXPORT_ROW_CAP,
  exportAuditMetadata,
  exportRowCountAllowed,
  ExportTooLarge,
  leadsToCsv,
  type ExportLeadRow,
} from './export-format';
export {
  assertExportSize,
  downloadDeadline,
  EXPORT_DAILY_LIMIT,
  EXPORT_MAX_BYTES,
  exportAuditFilters,
  exportAvailability,
  ExportFileTooLarge,
  exportFilters,
  ExportFiltersTooLarge,
  withoutSearch,
  type ExportAvailability,
  type ExportFilters,
  type ExportJobStatus,
} from './export-job';
export { CUSTOM_FIELD_TYPES, MAX_ACTIVE_CUSTOM_FIELDS } from './custom-fields';
export { leadForTask, leadScopeFilter, type TaskLead } from './task-links';
export { leadInScope, lockLeadForInteraction, type InteractionLead } from './interaction-links';
export { followUpDueRange } from './list-where';
export { handOverFollowUpsOf } from './follow-up-lifecycle';
export { parseOrgLocal } from './stages';
export {
  checkCustomValues,
  createCustomField,
  listCustomFields,
  lockedDefinitions,
  setCustomFieldArchived,
  setLeadCustomFields,
  updateCustomField,
  type CustomField,
} from './custom-field-commands';
export {
  createLeadSource,
  LEAD_SOURCE_CHANNELS,
  listLeadSourcesForSettings,
  normalizeSourceName,
  sourceKey,
  type LeadSourceChannel,
  type LeadSourceRow,
} from './source-commands';
export {
  bulkAddTag,
  createLeadTag,
  listLeadTags,
  MAX_TAGS_PER_ORG,
  tagsForLead,
  type LeadTagView,
} from './tags';
export {
  archiveLead,
  BULK_ARCHIVE_MAX,
  bulkArchiveLeads,
  listDuplicateCases,
  resolveDuplicateCase,
  restoreLead,
  type DuplicateCase,
} from './hygiene';
export {
  ARCHIVE_VIEWS,
  FOLLOW_UP_DUE,
  hasFilters,
  parseLeadQuery,
  LEAD_PAGE_SIZE,
  LEAD_SORTS,
  leadQueryString,
  type LeadQuery,
  type LeadSort,
  type SearchParams,
} from './list-query';

// ---------------------------------------------------------------------------------------------
// Create (FR-055) with duplicate detection (lead-lifecycle §5)

export type CreateLeadResult =
  | { status: 'created'; leadId: string }
  /** No lead was written. `leadId` is null when the existing lead is outside the caller's scope. */
  | {
      status: 'duplicate';
      leadId: string | null;
      canAttach: boolean;
      /** The match is archived (only told when the caller can see it; null leadId → false). */
      archived: boolean;
    };

export async function listLeadSources(
  ctx: RequestContext,
): Promise<{ id: string; name: string }[]> {
  authorize(ctx, 'lead.read');
  return tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.leadSource.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  );
}

const customValuesInput = z.object({ customFields: z.record(z.string(), z.unknown()).optional() });

export async function createLead(ctx: RequestContext, raw: unknown): Promise<CreateLeadResult> {
  authorize(ctx, 'lead.create');
  if (ctx.kind !== 'member') throw ruleViolation('Only organisation members can create leads');
  const input = createInput.parse(raw);
  const { customFields } = customValuesInput.parse(raw);
  const prepared = prepareLead(input);
  if (!prepared.ok) throw invalid(fieldErrors(prepared.issues));

  const phones = prepared.lead.phones;
  try {
    return await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      await lockPhones(tx, ctx.orgId, phones);
      const match = await findOpenMatch(tx, phones);
      if (match) {
        const visible = await tx.lead.findFirst({
          where: {
            AND: [{ id: match.id }, await scopeFilter(tx, ctx, authorize(ctx, 'lead.read'))],
          },
          select: { id: true },
        });
        return {
          status: 'duplicate' as const,
          leadId: visible ? match.id : null,
          canAttach: !!visible && (await inScope(tx, ctx, 'lead.update', match.id)),
          archived: !!visible && match.archivedAt !== null,
        };
      }

      let sourceId = input.sourceId;
      if (sourceId) {
        const source = await tx.leadSource.findFirst({
          where: { id: sourceId, isActive: true },
          select: { id: true },
        });
        if (!source) throw invalid({ sourceId: ['Choose an active source'] });
      } else sourceId = await ensureUnknownSource(tx, ctx.orgId);

      // FR-064: custom values are strict, and required fields must be given on manual create.
      const values = await validateCustomValues(tx, customFields, { requireRequired: true });

      // lead.create for Sales Executives is "auto-assigned to self" (roles §4.1): every manual
      // lead starts with its creator; others assign or reassign it afterwards (M3).
      const lead = await insertNewLead(tx, ctx, prepared.lead, {
        customFields: values,
        sourceId,
        ownerUserId: ctx.userId,
        teamId: await primaryTeamId(tx, ctx.membershipId),
        origin: 'UI',
      });
      const previous = lead.returning;
      await writeAudit(tx, ctx.orgId, {
        action: 'lead.created',
        entityType: 'lead',
        entityId: lead.leadId,
        actorUserId: ctx.userId,
        metadata: { stage: 'ASSIGNED', channel: 'UI', returningCustomer: previous },
      });
      return { status: 'created' as const, leadId: lead.leadId };
    });
  } catch (e) {
    if (isOpenPhoneConflict(e))
      throw conflict('An open lead with this phone number already exists');
    throw e;
  }
}

async function inScope(
  tx: Tx,
  ctx: RequestContext,
  permission: 'lead.update' | 'lead.read' | 'lead.reveal_phone' | 'interaction.create',
  leadId: string,
): Promise<boolean> {
  if (!can(ctx, permission)) return false;
  const row = await tx.lead.findFirst({
    where: { AND: [{ id: leadId }, await scopeFilter(tx, ctx, authorize(ctx, permission))] },
    select: { id: true },
  });
  return !!row;
}

const enquiryInput = z.object({ sourceId: opt(z.uuid()), campaign: opt(text(200)) });

/** FR-055: the duplicate's owner side — attach a returning enquiry to an in-scope open lead. */
export async function attachEnquiry(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<void> {
  authorize(ctx, 'lead.create');
  const scope = authorize(ctx, 'lead.update');
  const requested = parseId(leadId);
  const input = enquiryInput.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    // A merged lead's enquiries go to its survivor (D1), which must also be in scope.
    await findInScope(tx, ctx, scope, requested, { id: true });
    const id = await canonicalLeadId(tx, requested);
    const lead = await findInScope(tx, ctx, scope, id, {
      id: true,
      stage: true,
      archivedAt: true,
    });
    if (lead.stage === 'WON' || lead.stage === 'LOST')
      throw ruleViolation('Enquiries are attached to open leads only');
    let sourceId = input.sourceId;
    if (sourceId) {
      const ok = await tx.leadSource.findFirst({ where: { id: sourceId, isActive: true } });
      if (!ok) throw invalid({ sourceId: ['Choose an active source'] });
    } else sourceId = await ensureUnknownSource(tx, ctx.orgId);
    const enquiry = await tx.leadEnquiry.create({
      data: {
        orgId: ctx.orgId,
        leadId: id,
        sourceId,
        campaign: input.campaign ?? null,
        createdBy: ctx.userId,
      },
      select: { id: true },
    });
    await tx.leadActivity.create({
      data: {
        orgId: ctx.orgId,
        leadId: id,
        type: 'ENQUIRY',
        actorId: ctx.userId,
        summary: { channel: 'UI' },
        refType: 'lead_enquiry',
        refId: enquiry.id,
      },
    });
    await emitEvent(tx, ctx.orgId, {
      type: 'lead.enquiry_returned',
      payload: { leadId: id, enquiryId: enquiry.id, actorUserId: ctx.userId },
    });
    // D2: an archived lead stays archived; the enquiry opens a review case instead.
    await routeEnquiryForArchivedLead(tx, ctx, lead, enquiry.id);
  });
}

const reportInput = z.object({
  primaryPhone: z.string().max(64),
  alternatePhone: opt(z.string().max(64)),
  sourceId: opt(z.uuid()),
  campaign: opt(text(200)),
});

/**
 * FR-055 "request access" side of a duplicate the caller cannot see (lead-lifecycle §5.2):
 * the returning enquiry is attached to the matching open lead and its owner is notified. The
 * caller learns nothing about the lead: not its id, owner or details, only that it was reported.
 */
export async function reportDuplicateToOwner(
  ctx: RequestContext,
  raw: unknown,
): Promise<{ reported: boolean }> {
  authorize(ctx, 'lead.create');
  if (ctx.kind !== 'member') throw ruleViolation('Only organisation members can report enquiries');
  const input = reportInput.parse(raw);
  const primary = normaliseIndianPhone(input.primaryPhone);
  const alternate = normaliseIndianPhone(input.alternatePhone);
  if (!primary.ok || !primary.value)
    throw invalid({ primaryPhone: ['Enter a valid mobile number'] });
  const phones = [
    primary.value.e164,
    ...(alternate.ok && alternate.value ? [alternate.value.e164] : []),
  ];
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    await lockPhones(tx, ctx.orgId, phones);
    const match = await tx.lead.findFirst({
      where: {
        ...OPEN,
        OR: [{ primaryPhoneE164: { in: phones } }, { alternatePhoneE164: { in: phones } }],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, archivedAt: true },
    });
    if (!match) return { reported: false };
    let sourceId = input.sourceId;
    if (sourceId) {
      const ok = await tx.leadSource.findFirst({ where: { id: sourceId, isActive: true } });
      if (!ok) throw invalid({ sourceId: ['Choose an active source'] });
    } else sourceId = await ensureUnknownSource(tx, ctx.orgId);
    const enquiry = await tx.leadEnquiry.create({
      data: {
        orgId: ctx.orgId,
        leadId: match.id,
        sourceId,
        campaign: input.campaign ?? null,
        createdBy: ctx.userId,
      },
      select: { id: true },
    });
    await tx.leadActivity.create({
      data: {
        orgId: ctx.orgId,
        leadId: match.id,
        type: 'ENQUIRY',
        actorId: ctx.userId,
        summary: { channel: 'UI', reportedDuplicate: true },
        refType: 'lead_enquiry',
        refId: enquiry.id,
      },
    });
    await emitEvent(tx, ctx.orgId, {
      type: 'lead.enquiry_returned',
      payload: { leadId: match.id, enquiryId: enquiry.id, actorUserId: ctx.userId },
    });
    await routeEnquiryForArchivedLead(tx, ctx, match, enquiry.id);
    return { reported: true };
  });
}

// ---------------------------------------------------------------------------------------------
// Read (FR-057 Phase 2 part)

export interface LeadSummary {
  id: string;
  fullName: string;
  primaryPhoneE164: string;
  stage: LeadStage;
  intent: string | null;
  preferredCity: string | null;
  ownerName: string | null;
  /** null when unassigned; false for a suspended or deactivated owner. */
  ownerActive: boolean | null;
  teamName: string | null;
  createdAt: Date;
  /** M5: for the archive badge and bulk archive (each item is archived only at this version). */
  version: number;
  archivedAt: Date | null;
}

export interface LeadPage {
  query: LeadQuery;
  /** Parameter → message. When present no rows are returned: fix the filter first. */
  errors: Record<string, string>;
  rows: LeadSummary[];
  /** Opaque cursor for the next page, or null on the last page. */
  nextCursor: string | null;
}

/** Keyset position after the cursor row, matching the ORDER BY (id is the unique tie-breaker). */
function afterCursor(c: LeadCursor | null): Prisma.LeadWhereInput[] {
  if (!c) return [];
  if (c.s === 'newest') return [{ id: { lt: c.id } }];
  if (c.s === 'oldest') return [{ id: { gt: c.id } }];
  return [{ OR: [{ fullName: { gt: c.k! } }, { fullName: c.k!, id: { gt: c.id } }] }];
}

const ORDER: Record<LeadSort, Prisma.LeadOrderByWithRelationInput[]> = {
  // UUIDv7 ids are creation-ordered and unique, and (org_id, id) is indexed.
  newest: [{ id: 'desc' }],
  oldest: [{ id: 'asc' }],
  name: [{ fullName: 'asc' }, { id: 'asc' }],
};

/**
 * FR-056 lead list: search, filters, sort and cursor pagination over the caller's scope.
 * Scope (roles §2.2) and RLS apply first; filters and the cursor only narrow it. No totals are
 * computed. Parameters are validated here, so callers pass raw URL search params.
 */
export async function searchLeads(ctx: RequestContext, params: SearchParams): Promise<LeadPage> {
  const scope = authorize(ctx, 'lead.read');
  const { query, errors } = parseLeadQuery(params);
  if (Object.keys(errors).length) return { query, errors, rows: [], nextCursor: null };
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
    const phone = phoneDisplay(await phoneMaskingPolicy(tx, ctx.orgId)); // FR-060
    const cursor = query.cursor ? decodeLeadCursor(query.cursor, query.sort) : null;
    const rows = await tx.lead.findMany({
      where: {
        AND: [
          await scopeFilter(tx, ctx, scope),
          { mergedIntoLeadId: null }, // M5: merged tombstones are reached through their survivor
          ...filterWhere(query, timeZone),
          ...afterCursor(cursor),
        ],
      },
      orderBy: ORDER[query.sort],
      take: LEAD_PAGE_SIZE + 1,
      select: {
        id: true,
        fullName: true,
        primaryPhoneE164: true,
        stage: true,
        intent: true,
        preferredCity: true,
        createdAt: true,
        version: true,
        archivedAt: true,
        owner: { select: { status: true, user: { select: { name: true } } } },
        team: { select: { name: true } },
      },
    });
    const page = rows.slice(0, LEAD_PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      query,
      errors,
      rows: page.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        primaryPhoneE164: phone(r.primaryPhoneE164),
        stage: r.stage,
        intent: r.intent,
        preferredCity: r.preferredCity,
        ownerName: r.owner?.user.name ?? null,
        ownerActive: r.owner ? r.owner.status === 'ACTIVE' : null,
        teamName: r.team?.name ?? null,
        createdAt: r.createdAt,
        version: r.version,
        archivedAt: r.archivedAt,
      })),
      nextCursor: rows.length > LEAD_PAGE_SIZE && last ? encodeLeadCursor(query.sort, last) : null,
    };
  });
}

/** First page, newest first (kept for callers that need no filters). */
export async function listLeads(ctx: RequestContext): Promise<LeadSummary[]> {
  return (await searchLeads(ctx, {})).rows;
}

export interface LeadView extends Requirements {
  id: string;
  version: number;
  fullName: string;
  primaryPhoneE164: string;
  alternatePhoneE164: string | null;
  email: string | null;
  preferredLanguage: string | null;
  preferredContactMethod: string | null;
  sourceName: string;
  campaign: string | null;
  stage: LeadStage;
  contactStatus: ContactStatus;
  ownerUserId: string | null;
  ownerName: string | null;
  ownerActive: boolean | null;
  teamId: string | null;
  teamName: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** M5: archived leads are read-only until restored; a merged lead points at its survivor. */
  archivedAt: Date | null;
  mergedIntoLeadId: string | null;
  /** Stored custom values (FR-064), including values of archived fields. */
  customFields: Record<string, unknown>;
  /** What the caller may do; the commands re-check on the server. */
  canAssign: boolean;
  canViewAssignmentHistory: boolean;
  canUpdate: boolean;
  canChangeStage: boolean;
  canReopen: boolean;
  canViewTimeline: boolean;
  /** FR-060: the numbers above are masked (org setting); revealing them is a separate action. */
  phoneMasked: boolean;
  /** lead.reveal_phone in scope, while masking is on. */
  canRevealPhone: boolean;
  /** FR-065: lead.update in scope, and not merged (archived leads accept do-not-contact only). */
  canChangeContactStatus: boolean;
  /** lead.lift_do_not_contact (Owner/Admin). */
  canLiftDoNotContact: boolean;
  /** FR-083: may log an interaction here (interaction.create in scope, lead writable). */
  canLogInteraction: boolean;
}

export async function getLead(ctx: RequestContext, leadId: string): Promise<LeadView> {
  const scope = authorize(ctx, 'lead.read');
  const id = parseId(leadId);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const l = await findInScope(tx, ctx, scope, id, {
      id: true,
      version: true,
      fullName: true,
      primaryPhoneE164: true,
      alternatePhoneE164: true,
      email: true,
      preferredLanguage: true,
      preferredContactMethod: true,
      transactionType: true,
      propertyType: true,
      bhkMin: true,
      bhkMax: true,
      budgetMin: true,
      budgetMax: true,
      preferredCity: true,
      preferredLocalities: true,
      purpose: true,
      timeline: true,
      intent: true,
      campaign: true,
      stage: true,
      contactStatus: true,
      createdAt: true,
      updatedAt: true,
      ownerUserId: true,
      teamId: true,
      archivedAt: true,
      mergedIntoLeadId: true,
      customFields: true,
      source: { select: { name: true } },
      owner: { select: { status: true, user: { select: { name: true } } } },
      team: { select: { name: true } },
    });
    const stageScope = can(ctx, 'lead.update_stage') ? authorize(ctx, 'lead.update_stage') : null;
    const masking = await phoneMaskingPolicy(tx, ctx.orgId);
    const phone = phoneDisplay(masking); // FR-060: masked before it leaves the server
    const writable = !l.archivedAt && !l.mergedIntoLeadId;
    return {
      id: l.id,
      version: l.version,
      fullName: l.fullName,
      primaryPhoneE164: phone(l.primaryPhoneE164),
      alternatePhoneE164: phone(l.alternatePhoneE164),
      email: l.email,
      preferredLanguage: l.preferredLanguage,
      preferredContactMethod: l.preferredContactMethod,
      transactionType: l.transactionType,
      propertyType: l.propertyType,
      bhkMin: l.bhkMin,
      bhkMax: l.bhkMax,
      budgetMin: l.budgetMin?.toFixed(2) ?? null,
      budgetMax: l.budgetMax?.toFixed(2) ?? null,
      preferredCity: l.preferredCity,
      preferredLocalities: l.preferredLocalities,
      purpose: l.purpose,
      timeline: l.timeline,
      intent: l.intent,
      sourceName: l.source.name,
      campaign: l.campaign,
      stage: l.stage,
      contactStatus: l.contactStatus as ContactStatus,
      ownerUserId: l.ownerUserId,
      ownerName: l.owner?.user.name ?? null,
      ownerActive: l.owner ? l.owner.status === 'ACTIVE' : null,
      teamId: l.teamId,
      teamName: l.team?.name ?? null,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
      archivedAt: l.archivedAt,
      mergedIntoLeadId: l.mergedIntoLeadId,
      customFields: l.customFields as Record<string, unknown>,
      canAssign: writable && (await canAssignLead(tx, ctx, { id, ownerUserId: l.ownerUserId })),
      canViewAssignmentHistory: can(ctx, 'lead.view_assignment_history'),
      canUpdate: writable && (await inScope(tx, ctx, 'lead.update', id)),
      canChangeStage:
        writable &&
        stageScope !== null &&
        !!(await tx.lead.findFirst({
          where: { AND: [{ id }, await scopeFilter(tx, ctx, stageScope)] },
          select: { id: true },
        })),
      canReopen: stageScope === 'TEAM' || stageScope === 'ORG',
      canViewTimeline: can(ctx, 'lead.view_activity_timeline'),
      phoneMasked: masking.enabled,
      canRevealPhone: masking.enabled && (await inScope(tx, ctx, 'lead.reveal_phone', id)),
      canChangeContactStatus: !l.mergedIntoLeadId && (await inScope(tx, ctx, 'lead.update', id)),
      canLiftDoNotContact: can(ctx, 'lead.lift_do_not_contact'),
      // FR-083: log an interaction (writable lead in the caller's interaction.create scope).
      canLogInteraction: writable && (await inScope(tx, ctx, 'interaction.create', id)),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Update requirements (FR-058)

export async function updateRequirements(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<void> {
  const scope = authorize(ctx, 'lead.update');
  const id = parseId(leadId);
  const input = requirementsInput.parse(raw);
  const issues: FieldIssue[] = [];
  const reqs = toRequirements(input, issues);
  if (issues.length) throw invalid(fieldErrors(issues));
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const current = await findInScope(tx, ctx, scope, id, { version: true, ...WRITABLE_FIELDS });
    assertWritable(current);
    if (current.version !== input.version) throw staleVersion();
    await applyRequirements(tx, ctx, id, reqs, input.version);
  });
}

/**
 * The lead's requirements with a person's patch applied (FR-084: the outcome sheet sends only the
 * fields the person changed). The stored values are read in their form representation, the patch
 * replaces only its own fields, and the result goes through the same validation as the
 * requirements form (cross-field checks see the merged values). Issues are added to `issues`.
 */
export async function requirementsWithPatch(
  tx: Tx,
  id: string,
  patch: Partial<Record<RequirementField, string>>,
  issues: FieldIssue[],
): Promise<Requirements> {
  const l = await tx.lead.findUniqueOrThrow({
    where: { id },
    select: {
      transactionType: true,
      propertyType: true,
      bhkMin: true,
      bhkMax: true,
      budgetMin: true,
      budgetMax: true,
      preferredCity: true,
      preferredLocalities: true,
      purpose: true,
      timeline: true,
      intent: true,
    },
  });
  const stored: Record<RequirementField, string> = {
    transactionType: l.transactionType ?? '',
    propertyType: l.propertyType ?? '',
    bhkMin: l.bhkMin?.toString() ?? '',
    bhkMax: l.bhkMax?.toString() ?? '',
    budgetMin: l.budgetMin?.toFixed(2) ?? '',
    budgetMax: l.budgetMax?.toFixed(2) ?? '',
    preferredCity: l.preferredCity ?? '',
    preferredLocalities: l.preferredLocalities.join(', '),
    purpose: l.purpose ?? '',
    timeline: l.timeline ?? '',
    intent: l.intent ?? '',
  };
  const merged = requirementsInput
    .omit({ version: true })
    .parse({ ...stored, ...patch } as Record<string, string>);
  return toRequirements(merged, issues);
}

/**
 * Writes requirement changes inside the caller's transaction (the caller has checked lead.update
 * scope and validated `reqs`): only fields that differ from the stored values, optimistic-locked
 * on the version the form was built from, with one FIELD_CHANGED timeline entry. Returns the
 * changed field names; with none, nothing is written. Shared by the requirements form and the
 * interaction sheet (FR-084).
 */
export async function applyRequirements(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  reqs: Requirements,
  expectedVersion: number,
): Promise<(keyof Requirements)[]> {
  const current = await tx.lead.findUniqueOrThrow({
    where: { id },
    select: {
      version: true,
      transactionType: true,
      propertyType: true,
      bhkMin: true,
      bhkMax: true,
      budgetMin: true,
      budgetMax: true,
      preferredCity: true,
      preferredLocalities: true,
      purpose: true,
      timeline: true,
      intent: true,
      ...WRITABLE_FIELDS,
    },
  });
  assertWritable(current);
  const before: Record<string, unknown> = {
    ...current,
    budgetMin: current.budgetMin?.toFixed(2) ?? null,
    budgetMax: current.budgetMax?.toFixed(2) ?? null,
  };
  const changed = (Object.keys(reqs) as (keyof Requirements)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(reqs[k]),
  );
  if (!changed.length) return [];
  if (current.version !== expectedVersion) throw staleVersion();
  const res = await tx.lead.updateMany({
    where: { id, version: expectedVersion },
    data: { ...reqs, version: { increment: 1 }, updatedAt: new Date() },
  });
  if (res.count !== 1) throw staleVersion();
  await tx.leadActivity.create({
    data: {
      orgId: ctx.orgId,
      leadId: id,
      type: 'FIELD_CHANGED',
      actorId: ctx.userId,
      summary: { fields: changed },
    },
  });
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Stage change (FR-058, lead-lifecycle §2.1)

const stageInput = z.object({
  toStage: z.enum(LEAD_STAGES),
  version: z.coerce.number().int().min(1),
  reasonCode: opt(z.string().max(50)),
  reasonText: opt(text(1000)),
  visitAt: opt(z.string().max(32)),
  nurtureUntil: opt(z.string().max(32)),
});

export async function changeStage(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<void> {
  const scope = authorize(ctx, 'lead.update_stage');
  const id = parseId(leadId);
  const input = stageInput.parse(raw);
  try {
    await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const lead = await findInScope(tx, ctx, scope, id, {
        version: true,
        stage: true,
        primaryPhoneE164: true,
        transactionType: true,
        propertyType: true,
        preferredCity: true,
        budgetMin: true,
        budgetMax: true,
        firstContactedAt: true,
        qualifiedAt: true,
        firstVisitScheduledAt: true,
        firstVisitCompletedAt: true,
        wonAt: true,
        lostAt: true,
        ...WRITABLE_FIELDS,
      });
      assertWritable(lead);
      if (lead.version !== input.version) throw staleVersion();
      const now = new Date();
      const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
      const when = (v: string | undefined, field: string) => {
        if (v === undefined) return undefined;
        const d = parseOrgLocal(v, timeZone);
        if (!d) throw invalid({ [field]: ['Enter a valid date'] });
        return d;
      };
      const plan = planStageChange(
        lead.stage,
        {
          to: input.toStage,
          reasonCode: input.reasonCode,
          reasonText: input.reasonText ? cleanText(input.reasonText) : undefined,
          visitAt: when(input.visitAt, 'visitAt'),
          nurtureUntil: when(input.nurtureUntil, 'nurtureUntil'),
        },
        lead,
        { canReopen: scope !== 'OWN', now },
      );
      if (lead.stage === 'LOST') await lockPhones(tx, ctx.orgId, [lead.primaryPhoneE164]);
      // A Won/Lost lead keeps no open follow-ups (ADR-0010): cancelled first, in this
      // transaction (lead_closed_follow_up_guard refuses the stage change otherwise).
      if (input.toStage === 'WON' || input.toStage === 'LOST') {
        await closeFollowUpsForStage(tx, ctx, id, input.toStage);
        // ADR-0022: and no open site visits (lead_closed_visit_guard refuses otherwise).
        await closeVisitsForStage(tx, ctx, id, input.toStage);
      }
      await applyStageChange(tx, ctx, id, lead, input.toStage, plan, {
        expectedVersion: input.version,
        now,
        rule: null,
      });
    });
  } catch (e) {
    if (isOpenPhoneConflict(e))
      throw conflict('Another open lead has this phone number. Merge the leads instead.');
    throw e;
  }
}

/** Automatic stage rules (lead-lifecycle §2), recorded as SYSTEM_RULE with this reason code. */
export type StageRule =
  | 'FIRST_CONNECTED_INTERACTION'
  // FR-150–152 (ADR-0022): a visit scheduled, attended, or the only upcoming one cancelled.
  | 'SITE_VISIT_SCHEDULED'
  | 'SITE_VISIT_ATTENDED'
  | 'SITE_VISIT_CANCELLED'
  | 'SITE_VISIT_NO_SHOW';

/**
 * Writes a planned stage change inside the caller's transaction: the lead (stage, milestones set
 * once, version + 1, optimistic-locked), one history row per step, the STAGE timeline entry and
 * the audit row. A person's change has `rule: null` (source USER); an automatic one names its
 * rule (source SYSTEM_RULE, attributed to the person whose action triggered it).
 */
export async function applyStageChange(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  lead: { stage: LeadStage } & Record<MilestoneField, Date | null>,
  to: LeadStage,
  plan: StagePlan,
  opts: {
    expectedVersion: number;
    now: Date;
    rule: StageRule | null;
    /** The entity that caused the change (lead-lifecycle §2.1), e.g. the site visit. */
    related?: { type: string; id: string };
  },
): Promise<void> {
  const milestones: Partial<Record<MilestoneField, Date>> = milestonesReached(
    plan.steps,
    lead,
    opts.now,
  );
  const res = await tx.lead.updateMany({
    where: { id, version: opts.expectedVersion },
    data: { stage: to, ...milestones, version: { increment: 1 }, updatedAt: opts.now },
  });
  if (res.count !== 1) throw staleVersion();
  for (const step of plan.steps)
    await tx.leadStageHistory.create({
      data: {
        orgId: ctx.orgId,
        leadId: id,
        fromStage: step.from,
        toStage: step.to,
        changedBy: ctx.userId,
        source: opts.rule ? 'SYSTEM_RULE' : 'USER',
        reasonCode: step.implied ? 'IMPLIED' : (opts.rule ?? plan.reasonCode),
        reasonText: step.implied ? null : plan.reasonText,
        ...(opts.related
          ? { relatedEntityType: opts.related.type, relatedEntityId: opts.related.id }
          : {}),
      },
    });
  await tx.leadActivity.create({
    data: {
      orgId: ctx.orgId,
      leadId: id,
      type: 'STAGE',
      actorId: ctx.userId,
      summary: {
        from: lead.stage,
        to,
        implied: plan.steps.filter((s) => s.implied).map((s) => s.to),
        ...(plan.reasonCode ? { reasonCode: plan.reasonCode } : {}),
        ...(opts.rule ? { rule: opts.rule } : {}),
        ...plan.details,
      },
    },
  });
  await writeAudit(tx, ctx.orgId, {
    action: 'lead.stage_changed',
    entityType: 'lead',
    entityId: id,
    actorUserId: ctx.userId,
    metadata: {
      from: lead.stage,
      to,
      reasonCode: plan.reasonCode,
      ...(opts.rule ? { rule: opts.rule } : {}),
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Notes (FR-059) and timeline (FR-032)

const noteInput = z.object({ body: z.string().max(5000) });

export async function addNote(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<{ id: string }> {
  const scope = authorize(ctx, 'lead.update');
  const requested = parseId(leadId);
  const { body } = noteInput.parse(raw);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    // A note for a merged lead goes to its survivor (D1), which must also be in scope.
    await findInScope(tx, ctx, scope, requested, { id: true });
    const id = await canonicalLeadId(tx, requested);
    assertWritable(await findInScope(tx, ctx, scope, id, WRITABLE_FIELDS));
    return insertNote(tx, ctx, id, body);
  });
}

/** Author only, within 15 minutes (also enforced by the lead_note RLS policy). */
export async function editNote(ctx: RequestContext, noteId: string, raw: unknown): Promise<void> {
  const scope = authorize(ctx, 'lead.update');
  const id = parseId(noteId, 'Note');
  const clean = cleanText(noteInput.parse(raw).body);
  if (!clean) throw invalid({ body: ['Write a note'] });
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const note = await tx.leadNote.findFirst({
      where: { id, lead: await scopeFilter(tx, ctx, scope) },
      select: { authorId: true, editedUntil: true },
    });
    if (!note) throw notFound('Note not found');
    if (note.authorId !== ctx.userId || note.editedUntil <= new Date())
      throw ruleViolation('Notes can be edited only by their author, within 15 minutes');
    const res = await tx.leadNote.updateMany({
      where: { id, authorId: ctx.userId, editedUntil: { gt: new Date() } },
      data: { body: clean, updatedAt: new Date() },
    });
    if (res.count !== 1)
      throw ruleViolation('Notes can be edited only by their author, within 15 minutes');
  });
}

export interface TimelineEntry {
  id: string;
  type: string;
  actorName: string | null;
  occurredAt: Date;
  summary: Record<string, unknown>;
  note: { id: string; body: string; editable: boolean; edited: boolean } | null;
  /** FR-085: the interaction's notes, for people with interaction.read (never in the summary). */
  interaction: { notes: string | null } | null;
  /** Set when the entry belongs to a lead that was merged into this one (D1, by reference). */
  fromMergedLeadId: string | null;
}

/** Newest first; the latest 200 entries (paging arrives with M2's list work). */
export async function getTimeline(ctx: RequestContext, leadId: string): Promise<TimelineEntry[]> {
  const scope = authorize(ctx, 'lead.view_activity_timeline');
  const id = parseId(leadId);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    await findInScope(tx, ctx, scope, id, { id: true });
    // Merge by reference (D1): the history of leads merged into this one is read in place.
    const ids = await historyLeadIds(tx, id);
    const rows = await tx.leadActivity.findMany({
      where: { leadId: { in: ids } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        id: true,
        type: true,
        occurredAt: true,
        summary: true,
        refType: true,
        refId: true,
        leadId: true,
        actor: { select: { user: { select: { name: true } } } },
      },
    });
    const noteIds = rows.filter((r) => r.refType === 'lead_note' && r.refId).map((r) => r.refId!);
    const notes = new Map(
      (
        await tx.leadNote.findMany({
          where: { id: { in: noteIds }, leadId: { in: ids } },
          select: {
            id: true,
            body: true,
            authorId: true,
            editedUntil: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      ).map((n) => [n.id, n]),
    );
    const interactionIds = can(ctx, 'interaction.read')
      ? rows.filter((r) => r.refType === 'interaction' && r.refId).map((r) => r.refId!)
      : [];
    const interactions = new Map(
      (interactionIds.length
        ? await tx.interaction.findMany({
            where: { id: { in: interactionIds }, leadId: { in: ids } },
            select: { id: true, notes: true },
          })
        : []
      ).map((i) => [i.id, i]),
    );
    const now = new Date();
    return rows.map((r) => {
      const n = r.refType === 'lead_note' && r.refId ? notes.get(r.refId) : undefined;
      const ix = r.refType === 'interaction' && r.refId ? interactions.get(r.refId) : undefined;
      return {
        id: r.id,
        type: r.type,
        actorName: r.actor?.user.name ?? null,
        occurredAt: r.occurredAt,
        summary: (r.summary ?? {}) as Record<string, unknown>,
        note: n
          ? {
              id: n.id,
              body: n.body,
              editable: ctx.kind === 'member' && n.authorId === ctx.userId && n.editedUntil > now,
              edited: n.updatedAt.getTime() - n.createdAt.getTime() > 1000,
            }
          : null,
        interaction: ix ? { notes: ix.notes } : null,
        fromMergedLeadId: r.leadId === id ? null : r.leadId,
      };
    });
  });
}
