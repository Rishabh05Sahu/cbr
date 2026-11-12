'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import { logInteraction, recordCallIntent, type CallIntentResult, type LogResult } from './index';

/** Only these fields are read; an org id, actor, source or timestamp in the form is ignored. */
const FIELDS = [
  'leadId',
  'idempotencyKey',
  'scriptVersionId',
  'version',
  'channel',
  'direction',
  'outcome',
  'occurredAt',
  'durationMinutes',
  'notes',
  'confirmInvalidNumber',
  'confirmStatusChange',
  'statusReason',
  'statusMethod',
  'statusEvidenceRef',
  'requirementFields',
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
  'followUpTaskId',
  'followUpVersion',
  'completeFollowUp',
  'nextDueAt',
  'nextTitle',
  'rescheduleReason',
] as const;

export async function logInteractionAction(
  _: ActionResult<LogResult> | null,
  fd: FormData,
): Promise<ActionResult<LogResult>> {
  const input = Object.fromEntries(
    FIELDS.map((k) => {
      const v = fd.get(k);
      return [k, typeof v === 'string' ? v : ''];
    }),
  );
  const r = await runAction(async () => logInteraction(await requireContext(), input));
  if (r.ok) {
    revalidatePath(`/app/leads/${input.leadId}`);
    revalidatePath('/app/my-day');
  }
  return r;
}

/**
 * FR-080/081: one Call or WhatsApp tap. Returns the link for the browser to open. Nothing is
 * revalidated here: the page refreshes when the person comes back (the FR-082 prompt).
 */
export async function recordCallIntentAction(
  fd: FormData,
): Promise<ActionResult<CallIntentResult>> {
  const input = Object.fromEntries(
    (['leadId', 'channel', 'numberKind', 'confirmInvalidNumber'] as const).map((k) => {
      const v = fd.get(k);
      return [k, typeof v === 'string' && v !== '' ? v : undefined];
    }),
  );
  return runAction(async () => recordCallIntent(await requireContext(), input));
}
