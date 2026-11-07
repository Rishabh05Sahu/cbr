'use client';
// One site visit on the lead page (FR-151/152): its time, meeting point, assignee, status and
// outcome, and for a caller who may change it: Confirm, Reschedule (new time + reason), Cancel
// (reason) and, from the visit's day, No-show (reason) or Attended (interest, objections, notes,
// next action). The row stays mounted when it closes, so its result is still shown. The server
// re-checks every permission, transition, time rule and the version. No call or message links.
import { useRouter } from 'next/navigation';
import { startTransition, useActionState, useEffect, useState, type FormEvent } from 'react';
import { fieldErrorLines, warningOf } from '@/components/action-form';
import { Alert, Badge, Button, Field, Input, Select } from '@/components/ui';
import type { VisitView } from '@/modules/visits';
import { updateVisitAction } from '@/modules/visits/actions';
import { INTEREST_LEVELS, VISIT_LABELS, type VisitAction } from '@/modules/visits/rules';
import { fmtDateTime } from '../labels';

const textareaClass = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const LABELS = {
  scheduledFor: 'New date and time',
  reason: 'Reason',
  interestLevel: 'Interest level',
  objections: 'Objections',
  notes: 'Notes',
  nextAction: 'Next action',
};
const DONE: Record<VisitAction, string> = {
  confirm: 'Visit confirmed.',
  reschedule: 'Visit rescheduled.',
  cancel: 'Visit cancelled.',
  no_show: 'Recorded as a no-show.',
  attended: 'Recorded as attended.',
};
type Panel = 'reschedule' | 'cancel' | 'no_show' | 'attended';

export function VisitRow({ visit: v, leadId }: { visit: VisitView; leadId: string }) {
  const router = useRouter();
  const [state, act, pending] = useActionState(updateVisitAction, null);
  const [last, setLast] = useState<{ action: VisitAction; before: typeof state } | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const result = last && state !== last.before ? state : null;
  const open = result?.ok ? null : panel;
  useEffect(() => {
    if (result && !result.ok && result.error.code === 'CONFLICT') router.refresh();
  }, [result, router]);
  const submit = (action: VisitAction) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setLast({ action, before: state });
    startTransition(() => act(data));
  };
  const hidden = (action: VisitAction) => (
    <>
      <input type="hidden" name="visitId" value={v.id} />
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="version" value={v.version} />
      <input type="hidden" name="action" value={action} />
    </>
  );
  const errors =
    result && !result.ok ? fieldErrorLines(result.error.fieldErrors ?? {}, LABELS) : [];
  const toggle = (p: Panel) => {
    setLast(null);
    setPanel(open === p ? null : p);
  };
  const id = (k: string) => `sv-${k}-${v.id}`;

  return (
    <li className="space-y-2 py-3 text-sm" data-testid="visit-row">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-slate-900">{fmtDateTime(v.scheduledFor)}</span>
        <Badge
          tone={
            v.status === 'ATTENDED'
              ? 'good'
              : v.status === 'CANCELLED' || v.status === 'NO_SHOW'
                ? 'warn'
                : 'neutral'
          }
        >
          {VISIT_LABELS[v.status]}
        </Badge>
        {v.rescheduleCount > 0 && (
          <span className="text-xs text-slate-600">
            rescheduled {v.rescheduleCount} time{v.rescheduleCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <p className="text-slate-800">Meeting point: {v.location}</p>
      <p className="text-xs text-slate-600">With {v.assigneeName}</p>
      {v.cancelReason && <p className="text-xs text-slate-600">Cancelled: {v.cancelReason}</p>}
      {v.noShowReason && <p className="text-xs text-slate-600">No-show: {v.noShowReason}</p>}
      {v.status === 'ATTENDED' && (
        <div className="space-y-1 rounded-md bg-slate-50 p-2 text-xs text-slate-700">
          <p>Interest: {VISIT_LABELS[v.interestLevel ?? ''] ?? '—'}</p>
          {v.objections.length > 0 && <p>Objections: {v.objections.join(', ')}</p>}
          {v.outcomeNotes && <p className="whitespace-pre-wrap">Notes: {v.outcomeNotes}</p>}
          <p>Next action: {v.nextAction}</p>
        </div>
      )}

      {result?.ok && last && <Alert tone="success">{DONE[last.action]}</Alert>}
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

      {v.canManage && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {v.status !== 'CONFIRMED' && (
              <form onSubmit={submit('confirm')}>
                {hidden('confirm')}
                <Button type="submit" variant="secondary" disabled={pending}>
                  Confirm
                </Button>
              </form>
            )}
            {v.outcomeDue && (
              <Button
                type="button"
                aria-expanded={open === 'attended'}
                onClick={() => toggle('attended')}
              >
                Attended…
              </Button>
            )}
            {v.outcomeDue && (
              <Button
                type="button"
                variant="secondary"
                aria-expanded={open === 'no_show'}
                onClick={() => toggle('no_show')}
              >
                No-show…
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              aria-expanded={open === 'reschedule'}
              onClick={() => toggle('reschedule')}
            >
              Reschedule…
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-expanded={open === 'cancel'}
              onClick={() => toggle('cancel')}
            >
              Cancel visit…
            </Button>
          </div>
          {open === 'reschedule' && (
            <form onSubmit={submit('reschedule')} className="space-y-3">
              {hidden('reschedule')}
              <Field label="New date and time" htmlFor={id('when')}>
                <Input id={id('when')} name="scheduledFor" type="datetime-local" required />
              </Field>
              <Field label="Reason" htmlFor={id('rs-reason')}>
                <Input id={id('rs-reason')} name="reason" maxLength={500} required />
              </Field>
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Save new time'}
              </Button>
            </form>
          )}
          {(open === 'cancel' || open === 'no_show') && (
            <form onSubmit={submit(open)} className="space-y-3">
              {hidden(open)}
              <Field
                label={open === 'cancel' ? 'Reason for cancelling' : 'Reason for the no-show'}
                htmlFor={id('reason')}
              >
                <Input id={id('reason')} name="reason" maxLength={500} required />
              </Field>
              <Button type="submit" variant="danger" disabled={pending}>
                {pending ? 'Saving…' : open === 'cancel' ? 'Cancel this visit' : 'Record no-show'}
              </Button>
            </form>
          )}
          {open === 'attended' && (
            <form onSubmit={submit('attended')} className="space-y-3">
              {hidden('attended')}
              <Field label="Interest level" htmlFor={id('interest')}>
                <Select id={id('interest')} name="interestLevel" defaultValue="" required>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {INTEREST_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {VISIT_LABELS[l]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Objections (optional)" htmlFor={id('obj')} hint="Separate with commas.">
                <Input id={id('obj')} name="objections" maxLength={4000} />
              </Field>
              <Field label="Notes (optional)" htmlFor={id('notes')}>
                <textarea
                  id={id('notes')}
                  name="notes"
                  maxLength={5000}
                  rows={3}
                  className={textareaClass}
                />
              </Field>
              <Field label="Next action (required)" htmlFor={id('next')}>
                <Input id={id('next')} name="nextAction" maxLength={500} required />
              </Field>
              <Button type="submit" disabled={pending}>
                {pending ? 'Saving…' : 'Record attended'}
              </Button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}
