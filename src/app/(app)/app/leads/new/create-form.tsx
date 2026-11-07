'use client';
// Manual lead entry (FR-055). On a duplicate nothing is saved: the user opens the existing lead
// or attaches this enquiry to it (only when it is in their scope; the server re-checks). For a
// lead they cannot see, they can only report the enquiry: its owner is notified (M3), and the
// user learns nothing about the lead.
import Link from 'next/link';
import { startTransition, useActionState, useState } from 'react';
import { ActionFormButton } from '@/components/action-form-button';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import {
  attachEnquiryAction,
  createLeadAction,
  reportDuplicateAction,
} from '@/modules/leads/actions';
import { CustomFieldInputs, type CustomFieldInputDef } from '../custom-field-inputs';

type Option = { value: string; label: string };

export function CreateLeadForm({
  sources,
  options,
  customFields,
}: {
  sources: Option[];
  customFields: CustomFieldInputDef[];
  options: Record<
    | 'transactionType'
    | 'propertyType'
    | 'preferredContactMethod'
    | 'purpose'
    | 'timeline'
    | 'intent',
    Option[]
  >;
}) {
  const [state, formAction, pending] = useActionState(createLeadAction, null);
  const [enquiry, setEnquiry] = useState({
    primaryPhone: '',
    alternatePhone: '',
    sourceId: '',
    campaign: '',
  });
  const errors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};
  const duplicate = state?.ok && state.data.status === 'duplicate' ? state.data : null;

  const choice = (name: keyof typeof options, labelText: string) => (
    <Field label={labelText} htmlFor={`lead-${name}`} error={errors[name]}>
      <Select id={`lead-${name}`} name={name} defaultValue="">
        <option value="">—</option>
        {options[name].map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
  const input = (name: string, labelText: string, props: Record<string, unknown> = {}) => (
    <Field label={labelText} htmlFor={`lead-${name}`} error={errors[name]}>
      <Input id={`lead-${name}`} name={name} {...props} />
    </Field>
  );

  return (
    <>
      {duplicate && (
        <Alert tone="warn">
          {duplicate.archived
            ? 'This phone number belongs to an archived lead, so nothing was saved. Attaching the enquiry keeps the lead archived and sends it to the duplicate review queue, where someone decides whether to restore it.'
            : 'An open lead with this phone number already exists, so nothing was saved.'}{' '}
          {duplicate.leadId ? (
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <Link
                href={`/app/leads/${duplicate.leadId}` as '/app/leads'}
                className="tap font-medium underline"
              >
                {duplicate.archived ? 'Open the archived lead' : 'Open the existing lead'}
              </Link>
              {duplicate.canAttach && (
                <ActionFormButton
                  action={attachEnquiryAction}
                  fields={{
                    leadId: duplicate.leadId,
                    sourceId: enquiry.sourceId,
                    campaign: enquiry.campaign,
                  }}
                  label="Attach this enquiry to it"
                />
              )}
            </span>
          ) : (
            <span className="mt-2 flex flex-wrap items-center gap-2">
              It is handled by another team member.
              <ActionFormButton
                action={reportDuplicateAction}
                fields={enquiry}
                label="Tell the owner about this enquiry"
                successMessage="The owner has been told."
              />
            </span>
          )}
        </Alert>
      )}
      <form
        action={formAction}
        // Submitted through a transition so a refused submission keeps what the user typed
        // (React clears a form after its action runs; M5 §I.4 U6). Success navigates away.
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          startTransition(() => formAction(data));
        }}
        className="space-y-6"
        onChange={(e) => {
          const t = e.target as unknown as HTMLInputElement;
          if (t.name in enquiry) setEnquiry((s) => ({ ...s, [t.name]: t.value }));
        }}
      >
        {state && !state.ok && <Alert tone="error">{state.error.message}</Alert>}
        <Card title="Customer">
          <div className="grid gap-4 sm:grid-cols-2">
            {input('fullName', 'Name', { required: true, maxLength: 200 })}
            {input('primaryPhone', 'Mobile number', {
              required: true,
              inputMode: 'tel',
              autoComplete: 'off',
              placeholder: '98765 43210',
            })}
            {input('alternatePhone', 'Alternate mobile (optional)', { inputMode: 'tel' })}
            {input('email', 'Email (optional)', { type: 'email', maxLength: 254 })}
            {choice('preferredContactMethod', 'Preferred contact')}
            {input('preferredLanguage', 'Language code (optional)', {
              maxLength: 2,
              placeholder: 'mr',
            })}
          </div>
        </Card>
        <Card title="Source">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Source" htmlFor="lead-sourceId" error={errors.sourceId}>
              <Select id="lead-sourceId" name="sourceId" defaultValue="">
                <option value="">Unknown</option>
                {sources
                  .filter((s) => s.label.toLowerCase() !== 'unknown')
                  .map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
              </Select>
            </Field>
            {input('campaign', 'Campaign (optional)', { maxLength: 200 })}
          </div>
        </Card>
        <Card title="Requirements">
          <div className="grid gap-4 sm:grid-cols-3">
            {choice('transactionType', 'Looking to')}
            {choice('propertyType', 'Property type')}
            {input('preferredCity', 'City', { maxLength: 100 })}
            {input('budgetMin', 'Budget from', { placeholder: '50 L' })}
            {input('budgetMax', 'Budget up to', { placeholder: '1.2 Cr' })}
            {input('preferredLocalities', 'Localities (comma-separated)')}
            {input('bhkMin', 'BHK from', { type: 'number', min: 0, max: 20 })}
            {input('bhkMax', 'BHK up to', { type: 'number', min: 0, max: 20 })}
            {choice('purpose', 'Purpose')}
            {choice('timeline', 'Timeline')}
            {choice('intent', 'Intent')}
          </div>
        </Card>
        {customFields.length > 0 && (
          <Card title="Custom fields">
            <div className="grid gap-4 sm:grid-cols-2">
              <CustomFieldInputs fields={customFields} errors={errors} />
            </div>
          </Card>
        )}
        <Card title="First note (optional)">
          <Field label="Note" htmlFor="lead-note" error={errors.note}>
            <textarea
              id="lead-note"
              name="note"
              maxLength={5000}
              rows={3}
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </Field>
        </Card>
        <Button type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Create lead'}
        </Button>
      </form>
    </>
  );
}
