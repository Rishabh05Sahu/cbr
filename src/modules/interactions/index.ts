// Interactions module (Phase 3 slice 8): manual interaction logging (FR-083), the one-submit
// outcome sheet (FR-084) and interactions on the lead timeline (FR-085). Migrations 0017 and
// 0018, ADR-0014. No launcher, call intent, provider call or message send exists here: an
// interaction is a person's record of a contact that already happened.
//
// One submission, one transaction (FR-084): the lead is locked, the whole request is validated,
// then the optional requirement changes, the interaction (its trigger writes the INTERACTION
// timeline entry), the automatic stage change (lead-lifecycle §2, Q5), an outcome-driven contact
// status change (Q3, through the contact status event) and the follow-up change are written. Any
// refusal rolls everything back.
//
// Idempotency (review M1, migration 0018): the interaction stores a fingerprint of the whole
// normalised submission. The same key with the same fingerprint returns the first result and
// writes nothing; the same key with different details is a conflict (nothing is written); a row
// from before 0018 has no fingerprint and cannot be verified, so a retry against it is refused.
// The lead scope is checked before any saved result is returned.
//
// Contact status (ADR-0012, owner decisions 2026-10-29): outbound contact follows
// assertOutboundAllowed (Do-Not-Contact refused with no override, Invalid only when confirmed),
// checked here and again by the database, against the lead's status when the interaction is
// logged (not at the reported time: ADR-0014, M2 option a). Inbound contact may be logged on a
// Do-Not-Contact lead and changes nothing (Q1). Logging never lifts Do-Not-Contact and is never
// treated as consent.
//
// FR-098 (migration 0019, ADR-0014 decision 16): the interaction may carry the published script
// version last shown in the lead-page drawer; only a published version of the org, and only for
// people who may read scripts.
import { z } from 'zod';
import * as leads from '@/modules/leads';
import {
  completeFollowUpIn,
  followUpError,
  rescheduleFollowUpIn,
  scheduleFollowUpIn,
} from '@/modules/tasks';
import { authorize, can, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { conflict, DomainError, forbidden, ruleViolation } from '@/platform/errors';
import { requestFingerprint } from './fingerprint';
import {
  CHANNELS,
  contactStatusEffect,
  DIRECTIONS,
  durationAllowed,
  movesToContacted,
  occurredAtProblem,
  OCCURRED_MAX_AGE_MS,
  orgLocalInputValue,
  outboundChannelFor,
  outcomeFits,
  OUTCOME_GROUPS,
  OUTCOMES,
  type Outcome,
} from './rules';

export * from './rules';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());
const checkbox = z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean());
const plain = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim());

const logInput = z.object({
  leadId: z.string().max(64),
  idempotencyKey: z.uuid('Reload the page and try again'),
  version: z.coerce.number().int().min(1),
  channel: z.enum(CHANNELS, 'Choose how you were in touch'),
  direction: z.enum(DIRECTIONS, 'Choose who made contact'),
  outcome: z.enum(OUTCOMES as [Outcome, ...Outcome[]], 'Choose what happened'),
  occurredAt: z.string().max(40),
  durationMinutes: opt(z.coerce.number().int('Whole minutes').min(1).max(600)),
  notes: opt(plain(2000)),
  confirmInvalidNumber: checkbox,
  // Q3: outcome-driven contact status change, with the contact status workflow's details.
  confirmStatusChange: checkbox,
  statusReason: opt(plain(500)),
  statusMethod: opt(plain(30)),
  statusEvidenceRef: opt(plain(300)),
  // Q4 / review L1: the names of the requirement fields the person changed (comma-separated);
  // only those fields are read from the submission, as a patch on the stored values.
  requirementFields: opt(z.string().max(500)),
  // Follow-up: the caller's own open follow-up, and/or the next one.
  followUpTaskId: opt(z.uuid()),
  followUpVersion: opt(z.coerce.number().int().positive()),
  completeFollowUp: checkbox,
  nextDueAt: opt(z.string().max(40)),
  nextTitle: opt(plain(200)),
  rescheduleReason: opt(plain(500)),
  // FR-098: the published script version last shown in the lead-page drawer (none: blank).
  scriptVersionId: opt(z.uuid('Reload the page and try again')),
});

export interface LogResult {
  interactionId: string;
  /** The same submission was already saved: nothing new was written. */
  duplicate: boolean;
  stageChangedTo: leads.LeadStage | null;
  contactStatusChangedTo: leads.ContactStatus | null;
  /** Why an outcome's requested status change was not made (it would weaken or repeat it). */
  contactStatusNote: string | null;
  requirementsChanged: string[];
  followUp: 'completed' | 'rescheduled' | 'scheduled' | 'completed_and_scheduled' | null;
}

const invalid = (fieldErrors: Record<string, string[]>) =>
  new DomainError('VALIDATION_FAILED', 'Please check the highlighted fields', fieldErrors);

const keyConflict = () =>
  conflict('This form was already used for another lead. Reload the page and try again.');
const changedConflict = () =>
  conflict(
    'This interaction was already saved, with different details. Nothing was changed. Reload the page to see what was saved, then log any further contact as a new interaction.',
  );
const unverifiableConflict = () =>
  conflict(
    'This form was already used for an interaction that cannot be compared with this one. Nothing was changed. Reload the page and try again.',
  );
/** Review L1: a real requirement edit on a lead that changed since the form was shown. */
const requirementsConflict = () =>
  new DomainError(
    'CONFLICT',
    'This lead was changed by someone else after you opened this page, so your requirement changes were not saved. Nothing was saved. Your entries are still in the form: undo your requirement changes to save the interaction without them, or reload the page to see the latest requirements.',
    { requirements: ['Changed by someone else since you opened this page'] },
  );

/** The requirement patch named by `requirementFields` (unknown names are refused). */
function requirementPatch(
  raw: unknown,
  names: string | undefined,
): { patch: Partial<Record<leads.RequirementField, string>> | null; unknown: string[] } {
  const list = [
    ...new Set(
      (names ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  ];
  const known = list.filter((n): n is leads.RequirementField =>
    (leads.REQUIREMENT_FIELDS as readonly string[]).includes(n),
  );
  if (!known.length)
    return { patch: null, unknown: list.filter((n) => !known.includes(n as never)) };
  const src = (raw ?? {}) as Record<string, unknown>;
  const patch: Partial<Record<leads.RequirementField, string>> = {};
  for (const k of known.sort()) {
    const v = src[k];
    patch[k] = typeof v === 'string' ? v.trim() : '';
  }
  return { patch, unknown: list.filter((n) => !known.includes(n as never)) };
}

/** Records one interaction and its effects (FR-083/084). */
export async function logInteraction(ctx: RequestContext, raw: unknown): Promise<LogResult> {
  const scope = authorize(ctx, 'interaction.create');
  if (ctx.kind !== 'member') throw forbidden();
  const input = logInput.parse(raw);
  // Field errors are collected, never overwritten (review L5).
  const errors: Record<string, string[]> = {};
  const add = (field: string, message: string) => (errors[field] ??= []).push(message);
  if (!outcomeFits(input.outcome, input.channel, input.direction))
    add('outcome', 'This outcome does not fit the channel and who made contact');
  if (input.durationMinutes !== undefined && !durationAllowed(input.channel))
    add('durationMinutes', 'Duration is for calls and meetings only');
  if (input.notes !== undefined && input.notes.length > 2000)
    add('notes', 'At most 2,000 characters');
  const { patch, unknown: unknownFields } = requirementPatch(raw, input.requirementFields);
  if (unknownFields.length) add('_', 'Reload the page and try again');
  // Follow-up: what the submission asks for must be something the sheet can do (review L5).
  const own = input.followUpTaskId;
  const rescheduling = !!own && !input.completeFollowUp && input.nextDueAt !== undefined;
  if (input.completeFollowUp && !own)
    add('completeFollowUp', 'There is no open follow-up of yours to mark done');
  if (own && input.followUpVersion === undefined) add('_', 'Reload the page and try again');
  if (input.rescheduleReason !== undefined && !rescheduling)
    add(
      'rescheduleReason',
      'A reason is only for rescheduling your follow-up: set the new time, or clear the reason',
    );
  if (input.nextTitle !== undefined && (input.nextDueAt === undefined || rescheduling))
    add(
      'nextTitle',
      input.nextDueAt === undefined
        ? 'Set the date and time of the next follow-up, or clear what to follow up on'
        : 'What to follow up on is only for a new follow-up, not a rescheduled one',
    );
  const now = new Date();

  try {
    return await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      // Scope first: someone who lost access gets "not found", never an earlier saved result.
      const lead = await leads.lockLeadForInteraction(tx, ctx, scope, input.leadId);
      const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
      const occurredAt = leads.parseOrgLocal(input.occurredAt, timeZone);
      const nextDue =
        input.nextDueAt === undefined ? null : leads.parseOrgLocal(input.nextDueAt, timeZone);
      const fingerprint = requestFingerprint({
        idempotencyKey: input.idempotencyKey,
        leadId: lead.id,
        version: input.version,
        channel: input.channel,
        direction: input.direction,
        outcome: input.outcome,
        occurredAt: occurredAt?.toISOString() ?? input.occurredAt.trim(),
        durationMinutes: input.durationMinutes ?? null,
        notes: input.notes || null,
        confirmInvalidNumber: input.confirmInvalidNumber,
        status: {
          confirm: input.confirmStatusChange,
          reason: input.statusReason || null,
          method: input.statusMethod || null,
          evidenceRef: input.statusEvidenceRef || null,
        },
        requirements: patch,
        followUp: {
          taskId: own ?? null,
          taskVersion: input.followUpVersion ?? null,
          complete: input.completeFollowUp,
          nextDueAt: nextDue?.toISOString() ?? input.nextDueAt?.trim() ?? null,
          nextTitle: input.nextTitle || null,
          rescheduleReason: input.rescheduleReason || null,
        },
        scriptVersionId: input.scriptVersionId ?? null,
      });
      // A repeated submission (double tap, retry after a lost response) returns the first result
      // only when nothing in it changed.
      const first = await savedResult(tx, ctx, input.idempotencyKey, lead.id, fingerprint);
      if (first) return first;
      if (lead.mergedIntoLeadId) throw ruleViolation('This lead was merged into another lead');
      if (lead.archivedAt)
        throw ruleViolation('This lead is archived. Restore it before logging an interaction');

      const when = occurredAtProblem(occurredAt, now);
      if (when) add('occurredAt', when);

      // FR-065 outbound rule (the database re-checks it in interaction_guard).
      if (input.direction === 'OUTBOUND') {
        const e = leads.outboundEligibility(lead.contactStatus, outboundChannelFor(input.channel));
        if (!e.allowed)
          add(
            'direction',
            `${e.reason}: contact they did not start cannot be logged. You can log contact they started.`,
          );
        else if (e.requiresConfirmation && !input.confirmInvalidNumber)
          add(
            'confirmInvalidNumber',
            "This lead's number is marked invalid. Confirm that you contacted them anyway",
          );
      }

      // Q3: a requested contact status change, with the same details as the contact status card.
      const effect = contactStatusEffect(input.outcome, lead.contactStatus);
      const updateScope = can(ctx, 'lead.update') ? authorize(ctx, 'lead.update') : null;
      const mayUpdate =
        updateScope !== null && (await leads.leadInScope(tx, ctx, updateScope, lead.id));
      if (effect.kind === 'change') {
        if (!mayUpdate)
          add(
            'outcome',
            "This outcome changes the lead's contact status, which you cannot change on this lead",
          );
        else if (!input.confirmStatusChange)
          add(
            'confirmStatusChange',
            effect.to === 'DO_NOT_CONTACT'
              ? 'Confirm that this lead asked not to be contacted'
              : "Confirm that this lead's number is invalid",
          );
        const statusErrors = leads.contactStatusChangeErrors(
          {
            from: lead.contactStatus,
            to: effect.to,
            reason: input.statusReason ?? null,
            method: effect.to === 'DO_NOT_CONTACT' ? (input.statusMethod ?? null) : null,
            evidenceRef: input.statusEvidenceRef ?? null,
          },
          { canLift: false, archived: false },
        );
        for (const m of statusErrors.reason ?? []) add('statusReason', m);
        for (const m of statusErrors.method ?? []) add('statusMethod', m);
        for (const m of statusErrors.evidenceRef ?? []) add('statusEvidenceRef', m);
      }

      // Q4 / L1: only the fields the person changed, merged onto the stored values.
      let reqs: leads.Requirements | null = null;
      if (patch) {
        if (!mayUpdate) add('_', "You cannot change this lead's requirements");
        else {
          const issues: leads.FieldIssue[] = [];
          reqs = await leads.requirementsWithPatch(tx, lead.id, patch, issues);
          for (const i of issues) add(i.field, i.message);
        }
      }
      // FR-098: only a published version of this organisation, shown to someone who may read
      // scripts (interaction_script_version_guard checks the version again in the database).
      if (input.scriptVersionId !== undefined) {
        if (!can(ctx, 'script.read')) add('_', 'You cannot record a call script');
        else if (!(await scriptVersionIsPublished(tx, ctx.orgId, input.scriptVersionId)))
          add('_', 'The script shown is no longer available. Reload the page and try again');
      }
      if (Object.keys(errors).length) throw invalid(errors);

      // 1. Requirements (only changed fields). A real edit on a lead that changed since the form
      //    was shown is refused rather than overwriting the newer data.
      let requirementsChanged: string[] = [];
      if (reqs) {
        try {
          requirementsChanged = await leads.applyRequirements(
            tx,
            ctx,
            lead.id,
            reqs,
            input.version,
          );
        } catch (e) {
          if (e instanceof DomainError && e.code === 'CONFLICT') throw requirementsConflict();
          throw e;
        }
      }

      // 2. The interaction (and, by trigger, its INTERACTION timeline entry). Outbound contact
      //    goes through the shared FR-065 check as well (same rule as above, on the locked row).
      //    contact_status_at_log is the status before any change this submission makes (step 4).
      if (input.direction === 'OUTBOUND')
        await leads.assertOutboundAllowed(tx, lead.id, outboundChannelFor(input.channel), {
          confirmed: input.confirmInvalidNumber,
        });
      const created = await tx.interaction.create({
        data: {
          orgId: ctx.orgId,
          leadId: lead.id,
          userId: ctx.userId,
          channel: input.channel,
          direction: input.direction,
          outcome: input.outcome,
          outcomeGroup: OUTCOME_GROUPS[input.outcome],
          occurredAt: occurredAt!,
          manualDurationMinutes: input.durationMinutes ?? null,
          notes: input.notes || null,
          contactStatusAtLog: lead.contactStatus,
          invalidNumberConfirmed: input.direction === 'OUTBOUND' && input.confirmInvalidNumber,
          clientIdempotencyKey: input.idempotencyKey,
          requestFingerprint: fingerprint,
          scriptVersionId: input.scriptVersionId ?? null,
        },
        select: { id: true },
      });

      // 3. Lifecycle (Q5, review L2): only Assigned -> Contacted on a connected outcome, which
      //    also sets first_contacted_at (once; milestones are never overwritten) with its stage
      //    history, timeline entry and audit row. Other stages, including New, Won and Lost, are
      //    not moved and get no milestone.
      let stageChangedTo: leads.LeadStage | null = null;
      if (movesToContacted(input.outcome, lead.stage)) {
        const plan = leads.planStageChange('ASSIGNED', { to: 'CONTACTED' }, lead, {
          canReopen: false,
          now,
        });
        const { version } = await tx.lead.findUniqueOrThrow({
          where: { id: lead.id },
          select: { version: true },
        });
        await leads.applyStageChange(tx, ctx, lead.id, lead, 'CONTACTED', plan, {
          expectedVersion: version,
          now,
          rule: 'FIRST_CONNECTED_INTERACTION',
        });
        stageChangedTo = 'CONTACTED';
      }

      // 4. Contact status (Q3), through the contact status event in this transaction.
      let contactStatusChangedTo: leads.ContactStatus | null = null;
      if (effect.kind === 'change') {
        await leads.recordContactStatusChange(
          tx,
          ctx,
          lead.id,
          {
            toStatus: effect.to,
            reason: input.statusReason ?? null,
            method: effect.to === 'DO_NOT_CONTACT' ? (input.statusMethod ?? null) : null,
            evidenceRef: input.statusEvidenceRef ?? null,
          },
          { expectedVersion: null },
        );
        contactStatusChangedTo = effect.to;
      }

      // 5. Follow-up (FR-100/102/108 rules unchanged).
      const followUp = await applyFollowUp(tx, ctx, lead.id, input, now);

      return {
        interactionId: created.id,
        duplicate: false,
        stageChangedTo,
        contactStatusChangedTo,
        contactStatusNote: effect.kind === 'unchanged' ? effect.message : null,
        requirementsChanged,
        followUp,
      };
    });
  } catch (e) {
    // Two submissions with one key that did not meet on the lead lock (another lead): the
    // second rolled back entirely; it is told the form was used elsewhere.
    if (e instanceof Error && /client_idempotency_key/.test(e.message)) {
      const first = await tenantRunner().withTenant(ctx.tenant, (tx) =>
        savedResult(tx, ctx, input.idempotencyKey, null, null),
      );
      if (first) throw keyConflict();
    }
    throw followUpError(e);
  }
}

/** FR-098: whether a version is a published call-script version of the org (migration 0019). */
async function scriptVersionIsPublished(tx: Tx, orgId: string, versionId: string) {
  const [row] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT app.script_version_is_published(${orgId}::uuid, ${versionId}::uuid) AS ok`;
  return row?.ok === true;
}

/**
 * The saved result for this key, or null when the key is new. With a lead and a fingerprint:
 * another lead, different details or an unverifiable (pre-0018) row are conflicts.
 */
async function savedResult(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  key: string,
  leadId: string | null,
  fingerprint: string | null,
): Promise<LogResult | null> {
  const row = await tx.interaction.findUnique({
    where: {
      orgId_userId_clientIdempotencyKey: {
        orgId: ctx.orgId,
        userId: ctx.userId,
        clientIdempotencyKey: key,
      },
    },
    select: { id: true, leadId: true, requestFingerprint: true },
  });
  if (!row) return null;
  if (leadId !== null) {
    if (row.leadId !== leadId) throw keyConflict();
    if (row.requestFingerprint === null) throw unverifiableConflict();
    if (row.requestFingerprint !== fingerprint) throw changedConflict();
  }
  return {
    interactionId: row.id,
    duplicate: true,
    stageChangedTo: null,
    contactStatusChangedTo: null,
    contactStatusNote: null,
    requirementsChanged: [],
    followUp: null,
  };
}

type Input = z.infer<typeof logInput>;

/**
 * The follow-up part of the sheet. With the caller's own open follow-up: mark it done, and/or
 * set the next one (done + next = complete and schedule; next alone = reschedule, with the
 * FR-102 reason rule). Without one: optionally schedule the next one.
 */
async function applyFollowUp(
  tx: Tx,
  ctx: RequestContext,
  leadId: string,
  input: Input,
  now: Date,
): Promise<LogResult['followUp']> {
  const next = input.nextDueAt;
  const taskId = input.followUpTaskId;
  if (taskId && input.followUpVersion !== undefined) {
    if (input.completeFollowUp) {
      belongsTo(await completeFollowUpIn(tx, ctx, taskId, input.followUpVersion), leadId);
      if (!next) return 'completed';
      await scheduleFollowUpIn(
        tx,
        ctx,
        leadId,
        { dueAt: next, ...(input.nextTitle ? { title: input.nextTitle } : {}) },
        now,
      );
      return 'completed_and_scheduled';
    }
    if (!next) return null;
    belongsTo(
      await rescheduleFollowUpIn(
        tx,
        ctx,
        taskId,
        {
          dueAt: next,
          version: input.followUpVersion,
          ...(input.rescheduleReason ? { reason: input.rescheduleReason } : {}),
        },
        now,
      ),
      leadId,
    );
    return 'rescheduled';
  }
  if (!next) return null;
  await scheduleFollowUpIn(
    tx,
    ctx,
    leadId,
    { dueAt: next, ...(input.nextTitle ? { title: input.nextTitle } : {}) },
    now,
  );
  return 'scheduled';
}

function belongsTo(r: { leadId: string }, leadId: string): void {
  if (r.leadId !== leadId) throw ruleViolation('That follow-up belongs to another lead');
}

export interface SheetDefaults {
  /** Now, in the org's time zone, for the "when" input. */
  occurredAt: string;
  occurredMin: string;
  timeZone: string;
}

/** Values the outcome sheet needs from the org (lead page). */
export async function sheetDefaults(ctx: RequestContext): Promise<SheetDefaults> {
  authorize(ctx, 'interaction.create');
  const { timeZone } = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.organization.findFirstOrThrow({ select: { timeZone: true } }),
  );
  const now = new Date();
  return {
    occurredAt: orgLocalInputValue(now, timeZone),
    occurredMin: orgLocalInputValue(
      new Date(now.getTime() - OCCURRED_MAX_AGE_MS + 60_000),
      timeZone,
    ),
    timeZone,
  };
}
