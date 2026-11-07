'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as leads from './index';

type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};
/** Only the named fields are read; an org id, actor or timestamp in the form is ignored. */
const pick = (fd: FormData, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, str(fd, k)]));

const REQUIREMENT_FIELDS = [
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

const leadPath = (id: string) => `/app/leads/${id}`;

export async function createLeadAction(
  _: R | null,
  fd: FormData,
): Promise<ActionResult<leads.CreateLeadResult>> {
  const r = await runAction(async () => {
    const ctx = await requireContext();
    return leads.createLead(ctx, {
      ...pick(fd, [
        'fullName',
        'primaryPhone',
        'alternatePhone',
        'email',
        'preferredLanguage',
        'preferredContactMethod',
        'sourceId',
        'campaign',
        'note',
        ...REQUIREMENT_FIELDS,
      ]),
      // M5: the org's active custom fields (required ones are enforced by the server).
      customFields: await customValuesFrom(fd, ctx, 'create'),
    });
  });
  if (r.ok && r.data.status === 'created') {
    revalidatePath('/app/leads');
    redirect(leadPath(r.data.leadId) as never);
  }
  return r;
}

export async function attachEnquiryAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  const r = await runAction(async () =>
    leads.attachEnquiry(await requireContext(), leadId, pick(fd, ['sourceId', 'campaign'])),
  );
  if (r.ok) redirect(leadPath(leadId) as never);
  return r;
}

async function onLead<T>(leadId: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  const r = await runAction(fn);
  if (r.ok) revalidatePath(leadPath(leadId));
  return r;
}

export async function updateRequirementsAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  return onLead(leadId, async () =>
    leads.updateRequirements(
      await requireContext(),
      leadId,
      pick(fd, ['version', ...REQUIREMENT_FIELDS]),
    ),
  );
}

export async function changeStageAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  return onLead(leadId, async () =>
    leads.changeStage(
      await requireContext(),
      leadId,
      pick(fd, ['toStage', 'version', 'reasonCode', 'reasonText', 'visitAt', 'nurtureUntil']),
    ),
  );
}

export async function changeContactStatusAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  return onLead(leadId, async () =>
    leads.changeContactStatus(
      await requireContext(),
      leadId,
      pick(fd, ['toStatus', 'version', 'reason', 'method', 'evidenceRef']),
    ),
  );
}

/**
 * FR-060: one audited, capped reveal. The numbers come back only in this action's result (never
 * cached, nothing revalidated), so they live in the page's memory until the user leaves it.
 */
export async function revealLeadPhoneAction(
  _: ActionResult<leads.RevealedPhone> | null,
  fd: FormData,
): Promise<ActionResult<leads.RevealedPhone>> {
  return runAction(async () => leads.revealLeadPhone(await requireContext(), str(fd, 'leadId')));
}

export async function addNoteAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  return onLead(leadId, async () =>
    leads.addNote(await requireContext(), leadId, { body: str(fd, 'body') }),
  );
}

export async function editNoteAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  return onLead(leadId, async () =>
    leads.editNote(await requireContext(), str(fd, 'noteId'), { body: str(fd, 'body') }),
  );
}

// ---------------------------------------------------------------------------------------------
// Phase 2 M3: assignment

export async function assignLeadAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  return onLead(leadId, async () =>
    leads.assignLead(await requireContext(), leadId, pick(fd, ['target', 'version', 'reason'])),
  );
}

const leadIdsOf = (fd: FormData) =>
  fd.getAll('leadId').filter((v): v is string => typeof v === 'string');

export async function bulkAssignAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    leads.bulkAssign(await requireContext(), {
      leadIds: leadIdsOf(fd),
      target: str(fd, 'target'),
      reason: str(fd, 'reason'),
    }),
  );
  if (r.ok) revalidatePath('/app/leads', 'layout');
  return r;
}

export async function roundRobinAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    leads.roundRobinAssign(await requireContext(), {
      leadIds: leadIdsOf(fd),
      teamId: str(fd, 'teamId'),
    }),
  );
  if (r.ok) revalidatePath('/app/leads', 'layout');
  return r;
}

/** Out-of-scope duplicate: attach the enquiry and tell the owner, revealing nothing back. */
export async function reportDuplicateAction(_: R | null, fd: FormData) {
  return runAction(async () =>
    leads.reportDuplicateToOwner(
      await requireContext(),
      pick(fd, ['primaryPhone', 'alternatePhone', 'sourceId', 'campaign']),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Phase 2 M5: hygiene (archive/restore, review queue, merge), custom fields

/**
 * Custom values from a form ("cf.<key>"), converted by each field's DECLARED type. The conversion
 * is explicit, never a guess: a number field passes a number only when the text is a plain
 * decimal, otherwise the text itself goes to the server, which refuses it; a yes/no field passes
 * true/false only for those exact choices. Only active fields are read; anything else would be
 * refused by the server anyway. Create: blank = absent. Edit: blank = clear (null).
 */
async function customValuesFrom(
  fd: FormData,
  ctx: Awaited<ReturnType<typeof requireContext>>,
  mode: 'create' | 'edit',
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const f of await leads.listCustomFields(ctx)) {
    const name = `cf.${f.key}`;
    if (f.type === 'multi_select') {
      const all = fd.getAll(name).filter((v): v is string => typeof v === 'string' && v !== '');
      if (all.length) out[f.key] = all;
      else if (mode === 'edit') out[f.key] = null;
      continue;
    }
    const raw = str(fd, name).trim();
    if (!raw) {
      if (mode === 'edit') out[f.key] = null;
      continue;
    }
    if (f.type === 'number') out[f.key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    else if (f.type === 'boolean')
      out[f.key] = raw === 'true' ? true : raw === 'false' ? false : raw;
    else out[f.key] = raw;
  }
  return out;
}

export async function setCustomFieldsAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  return onLead(leadId, async () => {
    const ctx = await requireContext();
    return leads.setLeadCustomFields(ctx, leadId, {
      version: str(fd, 'version'),
      values: await customValuesFrom(fd, ctx, 'edit'),
    });
  });
}

export async function archiveLeadAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  const r = await onLead(leadId, async () =>
    leads.archiveLead(await requireContext(), leadId, pick(fd, ['version', 'reason'])),
  );
  if (r.ok) revalidatePath('/app/leads');
  return r;
}

export async function restoreLeadAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId');
  const r = await onLead(leadId, async () =>
    leads.restoreLead(await requireContext(), leadId, pick(fd, ['version'])),
  );
  if (r.ok) revalidatePath('/app/leads');
  return r;
}

/** Selection rows carry "<leadId>:<version>" so each lead is archived only as the user saw it. */
export async function bulkArchiveAction(_: R | null, fd: FormData) {
  const items = fd
    .getAll('item')
    .filter((v): v is string => typeof v === 'string')
    .map((v) => {
      const [id, version] = v.split(':');
      return { id: id ?? '', version: version ?? '' };
    });
  const r = await runAction(async () =>
    leads.bulkArchiveLeads(await requireContext(), { items, reason: str(fd, 'reason') }),
  );
  // Also after a refusal, so a stale list is reloaded with current versions.
  revalidatePath('/app/leads', 'layout');
  return r;
}

/** Selected lead ids from the list's "item" checkboxes ("<id>:<version>"); versions unused here. */
const selectedIds = (fd: FormData) =>
  fd
    .getAll('item')
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.split(':')[0] ?? '');

/** FR-063 bulk change team: lead ids and the team only; the org comes from the session. */
export async function bulkChangeTeamAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    leads.bulkChangeTeam(await requireContext(), {
      leadIds: selectedIds(fd),
      teamId: str(fd, 'teamId'),
    }),
  );
  revalidatePath('/app/leads', 'layout');
  return r;
}

/** FR-063 bulk add tag: lead ids and an existing tag only. */
export async function bulkAddTagAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    leads.bulkAddTag(await requireContext(), { leadIds: selectedIds(fd), tagId: str(fd, 'tagId') }),
  );
  revalidatePath('/app/leads', 'layout');
  return r;
}

/** Owner/Admin: a new tag (name only). */
export async function createLeadTagAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    leads.createLeadTag(await requireContext(), { name: str(fd, 'name') }),
  );
  if (r.ok) {
    revalidatePath('/app/settings/lead-tags');
    revalidatePath('/app/leads', 'layout');
  }
  return r;
}

export async function resolveCaseAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    leads.resolveDuplicateCase(await requireContext(), str(fd, 'caseId'), {
      decision: str(fd, 'decision'),
    }),
  );
  // Refresh only after a decision was recorded. After a conflict the page must not refresh under
  // the client first (the case would vanish with its controls): the client opens the queue with
  // a notice naming the other person's decision instead (M5 §I.4 U3).
  if (r.ok) revalidatePath('/app/leads', 'layout');
  return r;
}

export async function mergeLeadsAction(_: R | null, fd: FormData) {
  const resolutions: Record<string, string> = {};
  for (const [k, v] of fd.entries())
    if (k.startsWith('keep.') && typeof v === 'string') resolutions[k.slice(5)] = v;
  const r = await runAction(async () =>
    leads.mergeLeads(await requireContext(), {
      ...pick(fd, ['survivorId', 'mergedId', 'survivorVersion', 'mergedVersion']),
      resolutions,
    }),
  );
  if (r.ok) {
    revalidatePath('/app/leads', 'layout');
    redirect(leadPath(r.data.survivorId) as never);
  }
  return r;
}

const optionLines = (fd: FormData) =>
  str(fd, 'options')
    .split('\n')
    .map((o) => o.trim())
    .filter(Boolean);

export async function createCustomFieldAction(_: R | null, fd: FormData) {
  const options = optionLines(fd);
  const r = await runAction(async () =>
    leads.createCustomField(await requireContext(), {
      key: str(fd, 'key'),
      label: str(fd, 'label'),
      type: str(fd, 'type'),
      required: str(fd, 'required') === 'on',
      ...(options.length ? { options } : {}),
    }),
  );
  if (r.ok) revalidatePath('/app/settings/custom-fields');
  return r;
}

/** Label, required flag and options only: key and type are never sent (immutable). */
export async function updateCustomFieldAction(_: R | null, fd: FormData) {
  const options = optionLines(fd);
  const r = await runAction(async () =>
    leads.updateCustomField(await requireContext(), str(fd, 'fieldId'), {
      version: str(fd, 'version'),
      label: str(fd, 'label'),
      required: str(fd, 'required') === 'on',
      ...(options.length ? { options } : {}),
    }),
  );
  if (r.ok) revalidatePath('/app/settings/custom-fields');
  return r;
}

/** Name and channel only: the org comes from the session, never from the form. */
export async function createLeadSourceAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    leads.createLeadSource(await requireContext(), pick(fd, ['name', 'channel'])),
  );
  if (r.ok) {
    revalidatePath('/app/settings/lead-sources');
    revalidatePath('/app/leads/new');
    revalidatePath('/app/leads/import');
  }
  return r;
}

export async function setCustomFieldArchivedAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    leads.setCustomFieldArchived(
      await requireContext(),
      str(fd, 'fieldId'),
      str(fd, 'archived') === 'true',
      { version: str(fd, 'version') },
    ),
  );
  if (r.ok) revalidatePath('/app/settings/custom-fields');
  return r;
}
