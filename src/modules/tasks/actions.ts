'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import { DomainError, type ActionResult } from '@/platform/errors';
import * as tasks from './index';

type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};
/** Only the named fields are read; an org id, assignee, actor or timestamp in the form is ignored. */
const pick = (fd: FormData, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, str(fd, k)]));

/**
 * `leadId` only chooses the page to refresh. The follow-up's lead is always read from the task
 * on the server, never taken from the form.
 */
async function onLead<T>(fd: FormData, fn: () => Promise<T>): Promise<ActionResult<T>> {
  const r = await runAction(fn);
  if (r.ok && /^[0-9a-f-]{36}$/i.test(str(fd, 'leadId')))
    revalidatePath(`/app/leads/${str(fd, 'leadId')}`);
  return r;
}

export async function scheduleFollowUpAction(_: R | null, fd: FormData) {
  return onLead(fd, async () => {
    const input = pick(fd, ['dueAt', 'title', 'priority']);
    return tasks.scheduleFollowUp(await requireContext(), str(fd, 'leadId'), {
      ...input,
      priority: input.priority || undefined,
    });
  });
}

export async function rescheduleFollowUpAction(_: R | null, fd: FormData) {
  return onLead(fd, async () =>
    tasks.rescheduleFollowUp(
      await requireContext(),
      str(fd, 'taskId'),
      pick(fd, ['dueAt', 'reason', 'version']),
    ),
  );
}

export async function completeFollowUpAction(_: R | null, fd: FormData) {
  return onLead(fd, async () =>
    tasks.completeFollowUp(await requireContext(), str(fd, 'taskId'), pick(fd, ['version'])),
  );
}

/** FR-104: the checked attendees of a meeting form (one checkbox per person). */
const attendees = (fd: FormData) =>
  fd.getAll('attendeeUserIds').filter((v): v is string => typeof v === 'string');

/** FR-104: a meeting's end, location and attendees, from the lead page. */
export async function updateMeetingAction(_: R | null, fd: FormData) {
  return onLead(fd, async () =>
    tasks.updateMeeting(await requireContext(), str(fd, 'taskId'), {
      ...pick(fd, ['endAt', 'location', 'version']),
      attendeeUserIds: attendees(fd),
    }),
  );
}

export async function cancelFollowUpAction(_: R | null, fd: FormData) {
  return onLead(fd, async () =>
    tasks.cancelFollowUp(
      await requireContext(),
      str(fd, 'taskId'),
      pick(fd, ['reason', 'version']),
    ),
  );
}

/**
 * FR-100: a Call, Meeting, Document or Other task (FR-103: for oneself or someone else; FR-104:
 * meeting details). With a `leadId` (the lead page) it
 * is on that lead, and the server checks the lead; without, it has no lead (My Day).
 */
export async function createTaskAction(_: R | null, fd: FormData) {
  const leadId = str(fd, 'leadId') || null;
  const r = await runAction(async () => {
    const input = pick(fd, [
      'type',
      'title',
      'dueAt',
      'priority',
      'assigneeUserId',
      'endAt',
      'location',
    ]);
    return tasks.createTask(await requireContext(), leadId, {
      ...input,
      priority: input.priority || undefined,
      attendeeUserIds: attendees(fd),
    });
  });
  if (r.ok) revalidatePath(leadId ? `/app/leads/${leadId}` : '/app/my-day');
  return r;
}

/**
 * Complete, reschedule, cancel or (meetings) edit the details of a task from My Day (the server re-checks the task, and its lead
 * when it has one).
 */
export async function myDayTaskAction(_: R | null, fd: FormData) {
  const r = await runAction(async () => {
    const ctx = await requireContext();
    const taskId = str(fd, 'taskId');
    switch (str(fd, 'kind')) {
      case 'complete':
        return tasks.completeFollowUp(ctx, taskId, pick(fd, ['version']));
      case 'reschedule':
        return tasks.rescheduleFollowUp(ctx, taskId, pick(fd, ['dueAt', 'reason', 'version']));
      case 'cancel':
        return tasks.cancelFollowUp(ctx, taskId, pick(fd, ['reason', 'version']));
      case 'meeting':
        return tasks.updateMeeting(ctx, taskId, {
          ...pick(fd, ['endAt', 'location', 'version']),
          attendeeUserIds: attendees(fd),
        });
      default:
        throw new DomainError('VALIDATION_FAILED', 'Reload the page and try again');
    }
  });
  // The task leaves its section (done, cancelled) or moves (rescheduled).
  if (r.ok) revalidatePath('/app/my-day');
  return r;
}

/** FR-107: the template fields of a recurring-series form. */
const seriesFields = (fd: FormData) => ({
  ...pick(fd, [
    'title',
    'frequency',
    'weekday',
    'localTime',
    'endDate',
    'durationMinutes',
    'location',
  ]),
  priority: str(fd, 'priority') || undefined,
  attendeeUserIds: attendees(fd),
});

/** FR-107: a recurring series of one's own no-lead tasks (Owner, Admin, Sales Manager). */
export async function createSeriesAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    tasks.createSeries(await requireContext(), { ...seriesFields(fd), type: str(fd, 'type') }),
  );
  if (r.ok) revalidatePath('/app/my-day');
  return r;
}

/** FR-107: edit a series (future occurrences only). */
export async function updateSeriesAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    tasks.updateSeries(await requireContext(), str(fd, 'seriesId'), {
      ...seriesFields(fd),
      version: str(fd, 'version'),
    }),
  );
  if (r.ok) revalidatePath('/app/my-day');
  return r;
}

/**
 * FR-107: stop a series (the open occurrence stays). No revalidation: nothing else on My Day
 * changes, and re-rendering would drop the stopped series from the list together with its
 * confirmation (the row shows its stopped state until the next visit).
 */
export async function stopSeriesAction(_: R | null, fd: FormData) {
  return runAction(async () =>
    tasks.stopSeries(await requireContext(), str(fd, 'seriesId'), pick(fd, ['version'])),
  );
}
