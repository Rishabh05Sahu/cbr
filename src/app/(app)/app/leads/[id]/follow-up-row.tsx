'use client';
// One task on the lead page or My Day (FR-102): its state, and for the caller who may change it,
// Mark done, Reschedule and Cancel. A follow-up or another FR-100 type on a lead (lead page), or a
// task with no lead (My Day, `leadId` null: one action that takes the kind). A meeting also shows
// its end, location and attendees, and can have them edited (FR-104); a save that overlaps another
// meeting reports the server's warning. Open and recently closed tasks share one list keyed by
// task id, so a row stays mounted when it is completed or cancelled and its result ("Marked done.")
// is still shown (the Phase 2 archive lesson: feedback must not unmount with its form). The
// server re-checks every permission, the version and the reason rules.
import { useRouter } from 'next/navigation';
import {
  startTransition,
  useActionState,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { fieldErrorLines, warningOf } from '@/components/action-form';
import { Alert, Badge, Button, Field, Input } from '@/components/ui';
import {
  cancelFollowUpAction,
  completeFollowUpAction,
  myDayTaskAction,
  rescheduleFollowUpAction,
  updateMeetingAction,
} from '@/modules/tasks/actions';
import type { FollowUpView } from '@/modules/tasks';
import { TASK_TYPE_LABELS } from '@/modules/tasks/follow-up-rules';
import type { ActionResult } from '@/platform/errors';
import { fmtDateTime } from '../labels';
import { MeetingFields, meetingSummary, type MeetingPerson } from './meeting-fields';

type Kind = 'complete' | 'reschedule' | 'cancel' | 'meeting';
type State = ActionResult<unknown> | null;

const SUCCESS: Record<Kind, string> = {
  complete: 'Marked done.',
  reschedule: 'Rescheduled.',
  cancel: 'Cancelled.',
  meeting: 'Meeting details saved.',
};
const LABELS = {
  dueAt: 'New date and time',
  reason: 'Reason',
  version: 'Version',
  endAt: 'Ends at',
  location: 'Location or link',
  attendeeUserIds: 'Attendees',
};
const PRIORITY: Record<string, string> = { LOW: 'Low', HIGH: 'High', URGENT: 'Urgent' };

export function FollowUpRow({
  task,
  leadId,
  children,
  people = [],
}: {
  task: FollowUpView;
  /** The lead page's lead, or null on My Day (a task with no lead). */
  leadId: string | null;
  /** FR-104: who may be invited when editing a meeting. */
  people?: MeetingPerson[];
  /** Shown under the title (My Day: the lead or "No lead"); replaces the assignee line. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const onLead = leadId !== null;
  const [completeState, complete, completing] = useActionState(
    onLead ? completeFollowUpAction : myDayTaskAction,
    null,
  );
  const [rescheduleState, reschedule, rescheduling] = useActionState(
    onLead ? rescheduleFollowUpAction : myDayTaskAction,
    null,
  );
  const [cancelState, cancel, cancelling] = useActionState(
    onLead ? cancelFollowUpAction : myDayTaskAction,
    null,
  );
  const [meetingState, saveMeeting, savingMeeting] = useActionState(
    onLead ? updateMeetingAction : myDayTaskAction,
    null,
  );
  const meeting = task.type === 'MEETING';
  const noun = task.type === 'FOLLOW_UP' ? 'follow-up' : 'task';
  const [last, setLast] = useState<{ kind: Kind; before: State } | null>(null);
  const [open, setOpen] = useState<'reschedule' | 'cancel' | 'meeting' | null>(null);
  const pending = completing || rescheduling || cancelling || savingMeeting;
  const states: Record<Kind, State> = {
    complete: completeState,
    reschedule: rescheduleState,
    cancel: cancelState,
    meeting: meetingState,
  };
  // Only the action started last is reported, once it has a new result (as bulk-feedback.ts).
  const result = last && states[last.kind] !== last.before ? states[last.kind] : null;

  // A panel closes once its action succeeded; opening one starts afresh (clears the last result).
  const panel = result?.ok ? null : open;
  const toggle = (kind: 'reschedule' | 'cancel' | 'meeting') => {
    setLast(null);
    setOpen(panel === kind ? null : kind);
  };

  useEffect(() => {
    if (result && !result.ok && result.error.code === 'CONFLICT') router.refresh();
  }, [result, router]);

  const submit =
    (kind: Kind, action: (fd: FormData) => void) => (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      setLast({ kind, before: states[kind] });
      // A transition (not the form action) keeps what was typed when the server refuses it.
      startTransition(() => action(data));
    };
  const hidden = (kind: Kind) => (
    <>
      <input type="hidden" name="taskId" value={task.id} />
      {onLead ? (
        <input type="hidden" name="leadId" value={leadId} />
      ) : (
        <input type="hidden" name="kind" value={kind} />
      )}
      <input type="hidden" name="version" value={task.version} />
    </>
  );
  const errors =
    result && !result.ok ? fieldErrorLines(result.error.fieldErrors ?? {}, LABELS) : [];

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="font-medium text-slate-900">{fmtDateTime(task.dueAt)}</span>
        {task.status === 'OPEN' && task.overdue && <Badge tone="warn">Overdue</Badge>}
        {task.status === 'DONE' && <Badge tone="good">Done</Badge>}
        {task.status === 'CANCELLED' && <Badge>Cancelled</Badge>}
        {task.type !== 'FOLLOW_UP' && <Badge>{TASK_TYPE_LABELS[task.type]}</Badge>}
        {task.seriesId && <Badge>Repeats</Badge>}
        {PRIORITY[task.priority] && <Badge>{PRIORITY[task.priority]} priority</Badge>}
      </div>
      {task.title && <p className="text-sm text-slate-800">{task.title}</p>}
      {meeting &&
        meetingSummary(task, fmtDateTime).map((line) => (
          <p key={line} className="text-xs text-slate-700">
            {line}
          </p>
        ))}
      {task.assignedByName && (
        <p className="text-xs text-slate-600">Assigned by {task.assignedByName}</p>
      )}
      {children}
      {children ? null : (
        <p className="text-xs text-slate-600">
          {task.assigneeName ?? 'Former member'}
          {task.rescheduleCount > 0 &&
            ` · rescheduled ${task.rescheduleCount} time${task.rescheduleCount === 1 ? '' : 's'}`}
          {task.completedAt && ` · done ${fmtDateTime(task.completedAt)}`}
          {task.cancelledAt && ` · cancelled ${fmtDateTime(task.cancelledAt)}`}
        </p>
      )}
      {task.cancelReason && <p className="text-xs text-slate-600">Reason: {task.cancelReason}</p>}

      {result?.ok && last && <Alert tone="success">{SUCCESS[last.kind]}</Alert>}
      {result?.ok && warningOf(result.data) && <Alert tone="warn">{warningOf(result.data)}</Alert>}
      {result && !result.ok && (
        <Alert tone="error">
          {result.error.message}
          {errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {errors.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      {task.canUpdate && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <form onSubmit={submit('complete', complete)}>
              {hidden('complete')}
              <Button type="submit" disabled={pending}>
                {completing ? 'Saving…' : 'Mark done'}
              </Button>
            </form>
            <Button
              type="button"
              variant="secondary"
              aria-expanded={panel === 'reschedule'}
              onClick={() => toggle('reschedule')}
            >
              Reschedule…
            </Button>
            {meeting && (
              <Button
                type="button"
                variant="secondary"
                aria-expanded={panel === 'meeting'}
                onClick={() => toggle('meeting')}
              >
                Edit meeting…
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              aria-expanded={panel === 'cancel'}
              onClick={() => toggle('cancel')}
            >
              Cancel {noun}…
            </Button>
          </div>
          {panel === 'meeting' && (
            <form onSubmit={submit('meeting', saveMeeting)} className="space-y-3">
              {hidden('meeting')}
              <p className="text-xs text-slate-600">
                To change the start, use Reschedule (the end moves with it).
              </p>
              <MeetingFields
                idPrefix={`mt-${task.id}`}
                people={people.filter((p) => p.userId !== task.assigneeUserId)}
                endAtLocal={task.endAtLocal}
                location={task.location}
                attendeeIds={task.attendees.map((a) => a.userId)}
                meetingOnly={false}
              />
              <Button type="submit" disabled={pending}>
                {savingMeeting ? 'Saving…' : 'Save meeting details'}
              </Button>
            </form>
          )}
          {panel === 'reschedule' && (
            <form onSubmit={submit('reschedule', reschedule)} className="space-y-3">
              {hidden('reschedule')}
              <Field label="New date and time" htmlFor={`rs-due-${task.id}`}>
                <Input id={`rs-due-${task.id}`} name="dueAt" type="datetime-local" required />
              </Field>
              <Field
                label={task.rescheduleNeedsReason ? 'Reason (required)' : 'Reason (optional)'}
                htmlFor={`rs-reason-${task.id}`}
                {...(task.rescheduleNeedsReason
                  ? {
                      hint: task.overdue
                        ? `This ${noun} is overdue.`
                        : `This ${noun} was already rescheduled twice.`,
                    }
                  : {})}
              >
                <Input
                  id={`rs-reason-${task.id}`}
                  name="reason"
                  maxLength={500}
                  required={task.rescheduleNeedsReason}
                />
              </Field>
              <Button type="submit" disabled={pending}>
                {rescheduling ? 'Saving…' : 'Save new time'}
              </Button>
            </form>
          )}
          {panel === 'cancel' && (
            <form onSubmit={submit('cancel', cancel)} className="space-y-3">
              {hidden('cancel')}
              <Field label="Reason for cancelling" htmlFor={`cx-reason-${task.id}`}>
                <Input id={`cx-reason-${task.id}`} name="reason" maxLength={500} required />
              </Field>
              <Button type="submit" variant="danger" disabled={pending}>
                {cancelling ? 'Saving…' : `Cancel this ${noun}`}
              </Button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}
