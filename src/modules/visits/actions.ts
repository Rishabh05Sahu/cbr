'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as visits from './index';

type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};
/** Only the named fields are read; an org id, actor, status or timestamp in the form is ignored. */
const pick = (fd: FormData, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, str(fd, k)]));

/** `leadId` only chooses the pages to refresh; the visit's lead is read on the server. */
function refresh(fd: FormData) {
  const leadId = str(fd, 'leadId');
  if (/^[0-9a-f-]{36}$/i.test(leadId)) revalidatePath(`/app/leads/${leadId}`);
  revalidatePath('/app/visits');
}

/** FR-150: schedule a site visit on a lead. */
export async function scheduleVisitAction(_: R | null, fd: FormData) {
  const r = await runAction(async () => {
    const input = pick(fd, ['scheduledFor', 'location', 'assigneeUserId']);
    return visits.scheduleVisit(await requireContext(), str(fd, 'leadId'), {
      ...input,
      assigneeUserId: input.assigneeUserId || undefined,
    });
  });
  if (r.ok) refresh(fd);
  return r;
}

/** FR-151/152: confirm, reschedule, cancel, no-show or attended. */
export async function updateVisitAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    visits.updateVisit(
      await requireContext(),
      str(fd, 'visitId'),
      pick(fd, [
        'action',
        'version',
        'scheduledFor',
        'reason',
        'interestLevel',
        'objections',
        'notes',
        'nextAction',
      ]),
    ),
  );
  if (r.ok) refresh(fd);
  return r;
}
