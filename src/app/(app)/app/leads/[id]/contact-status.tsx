// FR-065 on the lead page: the banner (do-not-contact / invalid number), the change form and the
// history. The form stays mounted when no change is left to offer (for example after a Sales
// Executive records do-not-contact), so its "Contact status saved." result stays visible.
import { ActionForm } from '@/components/action-form';
import { Alert, Badge, Card, Field, Input, Select } from '@/components/ui';
import {
  allowedContactStatusTargets,
  CONTACT_METHOD_LABELS,
  CONTACT_STATUS_LABELS,
  DNC_METHODS,
  LIFT_BASES,
  type ContactStatus,
  type ContactStatusEventView,
} from '@/modules/leads';
import { changeContactStatusAction } from '@/modules/leads/actions';
import { fmtDateTime } from '../labels';

const textareaClass = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const ORIGIN_LABELS = {
  MANUAL: '',
  CARRY_OVER: 'carried over from an earlier lead for this number',
  MERGE: 'carried over from a merged duplicate',
} as const;

export function ContactStatusBanner({
  status,
  since,
}: {
  status: ContactStatus;
  since: ContactStatusEventView | null;
}) {
  if (status === 'OK') return null;
  const when = since ? ` on ${fmtDateTime(since.changedAt)}` : '';
  return (
    <div className="mb-6" data-testid="contact-status-banner">
      {status === 'DO_NOT_CONTACT' ? (
        <Alert tone="error">
          <strong>Do not contact.</strong> This person asked not to be contacted{when}. Do not call
          or message them by any channel.
        </Alert>
      ) : (
        <Alert tone="warn">
          <strong>Invalid number.</strong> The number was marked invalid{when}. Check it before
          contacting; calling it needs a confirmation.
        </Alert>
      )}
    </div>
  );
}

export function ContactStatusCard({
  leadId,
  version,
  status,
  archived,
  canChange,
  canLift,
  history,
}: {
  leadId: string;
  version: number;
  status: ContactStatus;
  archived: boolean;
  canChange: boolean;
  canLift: boolean;
  history: ContactStatusEventView[];
}) {
  const targets = canChange ? allowedContactStatusTargets(status, { canLift, archived }) : [];
  const lifting = status === 'DO_NOT_CONTACT';
  const methods = lifting ? LIFT_BASES : DNC_METHODS;
  return (
    <Card title="Contact status" description="Whether this person may be contacted.">
      <div className="space-y-4">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span>Current:</span>
          <Badge tone={status === 'OK' ? 'good' : 'warn'}>{CONTACT_STATUS_LABELS[status]}</Badge>
        </p>
        {canChange && (
          <ActionForm
            action={changeContactStatusAction}
            successMessage="Contact status saved."
            fieldLabels={{
              toStatus: 'New status',
              reason: 'Reason',
              method: lifting ? 'Consent basis' : 'How they asked',
              evidenceRef: 'Evidence reference',
            }}
            {...(targets.length ? { submitLabel: 'Save contact status' } : {})}
            className="space-y-4 border-t border-slate-100 pt-4"
          >
            <input type="hidden" name="leadId" value={leadId} />
            <input type="hidden" name="version" value={version} />
            {targets.length === 0 ? (
              <p className="text-sm text-slate-600">
                {lifting
                  ? 'Only an Owner or Admin can lift do-not-contact, with evidence of renewed consent.'
                  : 'No other contact status can be recorded for this lead.'}
              </p>
            ) : (
              <>
                {archived && (
                  <p className="text-sm text-slate-600">
                    This lead is archived: only do-not-contact can be recorded.
                  </p>
                )}
                <Field label="New status" htmlFor="cs-to">
                  <Select id="cs-to" name="toStatus" required defaultValue={targets[0]}>
                    {targets.map((t) => (
                      <option key={t} value={t}>
                        {CONTACT_STATUS_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label={lifting ? 'Consent basis' : 'How they asked (for do-not-contact)'}
                  htmlFor="cs-method"
                >
                  <Select id="cs-method" name="method" defaultValue="" required={lifting}>
                    <option value="">—</option>
                    {methods.map((m) => (
                      <option key={m} value={m}>
                        {CONTACT_METHOD_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reason" htmlFor="cs-reason">
                  <textarea
                    id="cs-reason"
                    name="reason"
                    required
                    maxLength={500}
                    rows={2}
                    className={textareaClass}
                  />
                </Field>
                <Field
                  label={lifting ? 'Evidence reference' : 'Evidence reference (optional)'}
                  htmlFor="cs-evidence"
                  hint={
                    lifting
                      ? 'Where the renewed consent is recorded, e.g. the form id or message date.'
                      : 'E.g. the date of the call or message.'
                  }
                >
                  <Input id="cs-evidence" name="evidenceRef" maxLength={300} required={lifting} />
                </Field>
              </>
            )}
          </ActionForm>
        )}
        {history.length > 0 && (
          <div className="border-t border-slate-100 pt-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">History</h3>
            <ul aria-label="Contact status history" className="divide-y divide-slate-100 text-sm">
              {history.map((h) => (
                <li key={h.id} className="space-y-1 py-2">
                  <p>
                    <strong>
                      {CONTACT_STATUS_LABELS[h.fromStatus]} → {CONTACT_STATUS_LABELS[h.toStatus]}
                    </strong>
                    {h.origin !== 'MANUAL' && ` (${ORIGIN_LABELS[h.origin]})`}
                  </p>
                  {h.method && (
                    <p className="text-slate-700">{CONTACT_METHOD_LABELS[h.method] ?? h.method}</p>
                  )}
                  {h.reason && <p className="whitespace-pre-wrap text-slate-700">{h.reason}</p>}
                  {h.evidenceRef && <p className="text-slate-700">Evidence: {h.evidenceRef}</p>}
                  <p className="text-xs text-slate-500">
                    {fmtDateTime(h.changedAt)}
                    {h.changedByName ? ` · ${h.changedByName}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
