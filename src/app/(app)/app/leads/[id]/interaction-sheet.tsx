'use client';
// FR-083/084 on the lead page: log one interaction (a contact that already happened) with its
// outcome, notes, optional requirement changes and the next follow-up, in one submission. The
// server re-checks everything in one transaction (src/modules/interactions). There is no call or
// WhatsApp launcher and no tel:/wa.me link here (FR-080/081 are not built).
//
// Idempotency: the form carries a key made when it is shown. A refused submission keeps it (a
// corrected retry is the same submission); a saved one gets a new key, so the next interaction is
// a new record. A double tap or a retried request is answered from the first save; the server
// refuses a retry whose details changed (request fingerprint, ADR-0014).
//
// Requirements (review L1): the optional section is prefilled, but only the fields the person
// actually changed are sent (as a patch, with their names in requirementFields). After a conflict
// the form keeps everything typed, and "Undo my requirement changes" restores the prefilled values
// so the interaction can be saved without them.
//
// Contact status (ADR-0012, owner decisions 2026-10-29): on a Do-Not-Contact lead only contact the
// customer started can be logged (Q1, Q2); an Invalid number needs a confirmation for outbound
// contact; the outcomes "asked not to be contacted" and "wrong / invalid number" change the
// status only after an explicit confirmation with a reason (Q3).
import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fieldErrorLines } from '@/components/action-form';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { useShownScript } from './shown-script';
import { logInteractionAction } from '@/modules/interactions/actions';
import type { LogResult } from '@/modules/interactions';
import {
  allowedOutcomes,
  CHANNEL_LABELS,
  CHANNELS,
  contactStatusEffect,
  DIRECTION_LABELS,
  DIRECTIONS,
  durationAllowed,
  movesToContacted,
  OUTCOME_LABELS,
  type Channel,
  type Direction,
  type Outcome,
} from '@/modules/interactions/rules';
import type { ContactStatus } from '@/modules/leads/contactability';
import type { ActionResult } from '@/platform/errors';
import { fmtDateTime } from '../labels';

const textareaClass = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const checkboxClass = 'mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300';
const FIELD_LABELS: Record<string, string> = {
  channel: 'Channel',
  direction: 'Who made contact',
  outcome: 'What happened',
  occurredAt: 'When',
  durationMinutes: 'Duration',
  notes: 'Notes',
  confirmInvalidNumber: 'Invalid number',
  confirmStatusChange: 'Contact status',
  statusReason: 'Reason',
  statusMethod: 'How they asked',
  statusEvidenceRef: 'Evidence reference',
  completeFollowUp: 'Follow-up',
  nextDueAt: 'Next follow-up',
  nextTitle: 'What to follow up on',
  rescheduleReason: 'Reason for rescheduling',
  idempotencyKey: 'Form',
  requirements: 'Requirements',
  dueAt: 'Next follow-up',
  reason: 'Reason',
  title: 'What to follow up on',
};

export interface SheetFollowUp {
  /** The caller's own open follow-up on this lead. */
  own: { id: string; version: number; dueAt: Date; rescheduleNeedsReason: boolean } | null;
  /** The caller may schedule a new one (no own open follow-up, lead open). */
  canSchedule: boolean;
  /** Why no follow-up can be set here (closed lead), if so. */
  blockedReason: string | null;
}

function newKey(): string {
  return crypto.randomUUID();
}

export function InteractionSheet({
  leadId,
  version,
  stage,
  contactStatus,
  occurredAt,
  occurredMin,
  followUp,
  dncMethods,
  requirementFields,
}: {
  leadId: string;
  version: number;
  stage: string;
  contactStatus: ContactStatus;
  occurredAt: string;
  occurredMin: string;
  followUp: SheetFollowUp | null;
  dncMethods: { code: string; label: string }[];
  requirementFields: ReactNode;
}) {
  const [state, formAction, pending] = useActionState<ActionResult<LogResult> | null, FormData>(
    logInteractionAction,
    null,
  );
  const dnc = contactStatus === 'DO_NOT_CONTACT';
  const [key, setKey] = useState(newKey);
  // FR-098: the script version last shown in the drawer on this page visit, if any.
  const { shown } = useShownScript();
  const [channel, setChannel] = useState<Channel>('PHONE_NATIVE');
  const [direction, setDirection] = useState<Direction>(dnc ? 'INBOUND' : 'OUTBOUND');
  const [outcome, setOutcome] = useState<Outcome | ''>('');
  const [completeOwn, setCompleteOwn] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const savedFor = useRef<ActionResult<LogResult> | null>(null);

  // On a Do-Not-Contact lead only contact the customer started can be logged.
  const effectiveDirection: Direction = dnc ? 'INBOUND' : direction;
  const outcomes = allowedOutcomes(channel, effectiveDirection);
  const chosen = outcome && outcomes.includes(outcome) ? outcome : '';
  const effect = chosen ? contactStatusEffect(chosen, contactStatus) : { kind: 'none' as const };
  const errors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};
  const lines = fieldErrorLines(errors, FIELD_LABELS);
  const err = (k: string) => errors[k];

  // A saved submission: new key and a clean form for the next interaction.
  useEffect(() => {
    if (!state?.ok || savedFor.current === state) return;
    savedFor.current = state;
    setKey(newKey());
    setOutcome('');
    setCompleteOwn(false);
    setChannel('PHONE_NATIVE');
    setDirection(dnc ? 'INBOUND' : 'OUTBOUND');
    formRef.current?.reset();
  }, [state, dnc]);

  const own = followUp?.own ?? null;
  return (
    <form
      ref={formRef}
      aria-label="Log an interaction"
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        const data = new FormData(e.currentTarget);
        const changed = changedRequirements(e.currentTarget);
        for (const el of requirementControls(e.currentTarget))
          if (!changed.includes(el.name)) data.delete(el.name);
        data.set('requirementFields', changed.join(','));
        startTransition(() => formAction(data));
      }}
      className="space-y-4"
      noValidate
    >
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <input type="hidden" name="scriptVersionId" value={shown?.versionId ?? ''} />
      {state && !state.ok && state.error.fieldErrors?.requirements && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            if (formRef.current) undoRequirements(formRef.current);
          }}
        >
          Undo my requirement changes
        </Button>
      )}
      {state && !state.ok && (
        <Alert tone="error">
          {state.error.message}
          {lines.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      {state?.ok && (
        <Alert tone="success">
          <span data-testid="interaction-saved">{savedMessage(state.data)}</span>
        </Alert>
      )}
      {dnc && (
        <p className="text-sm text-slate-700">
          This lead asked not to be contacted. You can log only contact they started; it does not
          permit contacting them.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Channel" htmlFor="ix-channel" error={err('channel')}>
          <Select
            id="ix-channel"
            name="channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel)}
          >
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset
          className="space-y-1"
          aria-describedby={err('direction') ? 'ix-dir-error' : undefined}
        >
          <legend className="block text-sm font-medium text-slate-800">Who made contact</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
            {DIRECTIONS.map((d) => (
              <label
                key={d}
                htmlFor={`ix-dir-${d}`}
                className="tap inline-flex items-center gap-2 text-sm"
              >
                <input
                  id={`ix-dir-${d}`}
                  type="radio"
                  name="direction"
                  value={d}
                  checked={effectiveDirection === d}
                  disabled={dnc && d === 'OUTBOUND'}
                  onChange={() => setDirection(d)}
                  className="h-5 w-5"
                />
                {DIRECTION_LABELS[d]}
              </label>
            ))}
          </div>
          {err('direction') && (
            <p id="ix-dir-error" className="text-sm text-red-700">
              {err('direction')!.join(' ')}
            </p>
          )}
        </fieldset>
        <Field label="What happened" htmlFor="ix-outcome" error={err('outcome')}>
          <Select
            id="ix-outcome"
            name="outcome"
            value={chosen}
            required
            onChange={(e) => setOutcome(e.target.value as Outcome | '')}
          >
            <option value="">Choose…</option>
            {outcomes.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABELS[o]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="When"
          htmlFor="ix-when"
          hint="Within the last seven days, in your organisation's time zone."
          error={err('occurredAt')}
        >
          <Input
            id="ix-when"
            name="occurredAt"
            type="datetime-local"
            defaultValue={occurredAt}
            min={occurredMin}
            required
          />
        </Field>
        {durationAllowed(channel) && (
          <Field
            label="Duration in minutes (optional, your estimate)"
            htmlFor="ix-duration"
            error={err('durationMinutes')}
          >
            <Input
              id="ix-duration"
              name="durationMinutes"
              type="number"
              min={1}
              max={600}
              inputMode="numeric"
            />
          </Field>
        )}
      </div>
      <Field label="Notes (optional)" htmlFor="ix-notes" error={err('notes')}>
        <textarea id="ix-notes" name="notes" maxLength={2000} rows={3} className={textareaClass} />
      </Field>

      {effectiveDirection === 'OUTBOUND' && contactStatus === 'INVALID' && (
        <Confirm
          id="ix-confirm-invalid"
          name="confirmInvalidNumber"
          error={err('confirmInvalidNumber')}
          label="This lead's number is marked invalid. I contacted them anyway."
        />
      )}

      {effect.kind === 'change' && (
        <fieldset className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
          <legend className="px-1 text-sm font-medium text-slate-900">Contact status</legend>
          <p className="text-sm text-slate-800">
            {effect.to === 'DO_NOT_CONTACT'
              ? 'Saving marks this lead do not contact. Every channel is then blocked, and only an Owner or Admin can lift it.'
              : "Saving marks this lead's number invalid. Contacting it then needs a confirmation."}
          </p>
          <Confirm
            id="ix-confirm-status"
            name="confirmStatusChange"
            error={err('confirmStatusChange')}
            label={
              effect.to === 'DO_NOT_CONTACT'
                ? 'They asked not to be contacted. Mark the lead do not contact.'
                : 'The number is wrong or invalid. Mark it invalid.'
            }
          />
          {effect.to === 'DO_NOT_CONTACT' && (
            <Field label="How they asked" htmlFor="ix-status-method" error={err('statusMethod')}>
              <Select id="ix-status-method" name="statusMethod" defaultValue="" required>
                <option value="">Choose…</option>
                {dncMethods.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Reason" htmlFor="ix-status-reason" error={err('statusReason')}>
            <Input id="ix-status-reason" name="statusReason" maxLength={500} required />
          </Field>
          <Field
            label="Evidence reference (optional)"
            htmlFor="ix-status-evidence"
            error={err('statusEvidenceRef')}
          >
            <Input id="ix-status-evidence" name="statusEvidenceRef" maxLength={300} />
          </Field>
        </fieldset>
      )}
      {effect.kind === 'unchanged' && <p className="text-sm text-slate-700">{effect.message}</p>}
      {chosen && movesToContacted(chosen, stage) && (
        <p className="text-sm text-slate-700">Saving moves the lead from Assigned to Contacted.</p>
      )}

      {requirementFields && (
        <details className="rounded-md border border-slate-200 p-3">
          <summary className="tap cursor-pointer text-sm font-medium text-slate-900">
            Update requirements (optional)
          </summary>
          <div key={version} data-requirements className="mt-3 grid gap-4 sm:grid-cols-3">
            {requirementFields}
          </div>
        </details>
      )}

      {followUp && (
        <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
          <legend className="px-1 text-sm font-medium text-slate-900">Follow-up</legend>
          {followUp.blockedReason ? (
            <p className="text-sm text-slate-600">{followUp.blockedReason}</p>
          ) : (
            <>
              {own && (
                <>
                  <input type="hidden" name="followUpTaskId" value={own.id} />
                  <input type="hidden" name="followUpVersion" value={own.version} />
                  <label
                    htmlFor="ix-fu-done"
                    className="tap flex items-start gap-2 text-sm text-slate-800"
                  >
                    <input
                      id="ix-fu-done"
                      type="checkbox"
                      name="completeFollowUp"
                      checked={completeOwn}
                      onChange={(e) => setCompleteOwn(e.target.checked)}
                      className={checkboxClass}
                    />
                    <span>Mark my follow-up for {fmtDateTime(own.dueAt)} done</span>
                  </label>
                </>
              )}
              {(own || followUp.canSchedule) && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={
                      own && !completeOwn
                        ? 'Reschedule my follow-up to (optional)'
                        : 'Next follow-up (optional)'
                    }
                    htmlFor="ix-fu-next"
                    error={err('nextDueAt') ?? err('dueAt')}
                  >
                    <Input id="ix-fu-next" name="nextDueAt" type="datetime-local" />
                  </Field>
                  {own && !completeOwn ? (
                    <Field
                      label={
                        own.rescheduleNeedsReason
                          ? 'Reason for rescheduling (needed)'
                          : 'Reason for rescheduling (optional)'
                      }
                      htmlFor="ix-fu-reason"
                      error={err('rescheduleReason') ?? err('reason')}
                    >
                      <Input id="ix-fu-reason" name="rescheduleReason" maxLength={500} />
                    </Field>
                  ) : (
                    <Field
                      label="What to follow up on (optional)"
                      htmlFor="ix-fu-title"
                      error={err('nextTitle') ?? err('title')}
                    >
                      <Input id="ix-fu-title" name="nextTitle" maxLength={200} />
                    </Field>
                  )}
                </div>
              )}
            </>
          )}
        </fieldset>
      )}

      {shown && (
        <p className="text-sm text-slate-700" data-testid="sheet-script-shown">
          Script shown: {shown.name} (version {shown.versionNo}). It is saved with this interaction.
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save interaction'}
      </Button>
    </form>
  );
}

function Confirm({
  id,
  name,
  label,
  error,
}: {
  id: string;
  name: string;
  label: string;
  error: string[] | undefined;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="tap flex items-start gap-2 text-sm text-slate-900">
        <input
          id={id}
          type="checkbox"
          name={name}
          required
          className={checkboxClass}
          {...(error ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {})}
        />
        <span>{label}</span>
      </label>
      {error && (
        <p id={`${id}-error`} className="text-sm text-red-700">
          {error.join(' ')}
        </p>
      )}
    </div>
  );
}

const FOLLOW_UP_TEXT: Record<NonNullable<LogResult['followUp']>, string> = {
  completed: 'Follow-up marked done.',
  rescheduled: 'Follow-up rescheduled.',
  scheduled: 'Next follow-up scheduled.',
  completed_and_scheduled: 'Follow-up marked done and the next one scheduled.',
};

function savedMessage(r: LogResult): string {
  if (r.duplicate) return 'This interaction was already saved. Nothing was added twice.';
  const parts = ['Interaction saved.'];
  if (r.requirementsChanged.length) parts.push('Requirements updated.');
  if (r.stageChangedTo === 'CONTACTED') parts.push('Stage moved to Contacted.');
  if (r.contactStatusChangedTo === 'DO_NOT_CONTACT') parts.push('Lead marked do not contact.');
  if (r.contactStatusChangedTo === 'INVALID') parts.push('Number marked invalid.');
  if (r.contactStatusNote) parts.push(r.contactStatusNote);
  if (r.followUp) parts.push(FOLLOW_UP_TEXT[r.followUp]);
  return parts.join(' ');
}

type RequirementControl = HTMLInputElement | HTMLSelectElement;

function requirementControls(form: HTMLFormElement): RequirementControl[] {
  return [
    ...form.querySelectorAll<RequirementControl>(
      '[data-requirements] input[name], [data-requirements] select[name]',
    ),
  ];
}

const initialValue = (el: RequirementControl) =>
  el instanceof HTMLSelectElement
    ? ([...el.options].find((o) => o.defaultSelected)?.value ?? el.options[0]?.value ?? '')
    : el.defaultValue;

/** The requirement fields whose value differs from what the page was rendered with. */
function changedRequirements(form: HTMLFormElement): string[] {
  return requirementControls(form)
    .filter((el) => el.value.trim() !== initialValue(el).trim())
    .map((el) => el.name);
}

/** Puts the prefilled requirement values back (the person's other entries stay). */
function undoRequirements(form: HTMLFormElement): void {
  for (const el of requirementControls(form)) el.value = initialValue(el);
}
