'use client';
// FR-142: a property's confidential contacts (owner, authorised agent, developer). Nothing is
// sent to the browser until "Show contacts" is pressed; each press is an audited server read.
// Owners and Admins can add and remove contacts here. No call or message links (G5).
import { startTransition, useActionState, useEffect, useState, type FormEvent } from 'react';
import { fieldErrorLines } from '@/components/action-form';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import type { PropertyContactView } from '@/modules/properties';
import {
  addContactAction,
  removeContactAction,
  revealContactsAction,
} from '@/modules/properties/actions';
import { CONTACT_RELATIONSHIPS, PROPERTY_LABELS } from '@/modules/properties/rules';
import type { ActionResult } from '@/platform/errors';

type State = ActionResult<unknown> | null;

export function ContactsPanel({
  propertyId,
  canManage,
}: {
  propertyId: string;
  canManage: boolean;
}) {
  const [shown, reveal, revealing] = useActionState(revealContactsAction, null);
  const [added, add, adding] = useActionState(addContactAction, null);
  const [removed, remove, removing] = useActionState(removeContactAction, null);
  const [lastAdd, setLastAdd] = useState<State>(null);
  const contacts = shown?.ok ? (shown.data as PropertyContactView[]) : null;
  const send = (action: (fd: FormData) => void, fd: FormData) => startTransition(() => action(fd));
  const refresh = () => {
    const fd = new FormData();
    fd.set('propertyId', propertyId);
    send(reveal, fd);
  };
  // After an add or remove succeeds, read the list again (another audited read).
  useEffect(() => {
    if ((added?.ok && added !== lastAdd) || removed?.ok) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [added, removed]);
  const addErrors =
    added && !added.ok
      ? fieldErrorLines(added.error.fieldErrors ?? {}, {
          phone: 'Phone',
          email: 'Email',
          name: 'Name',
        })
      : [];

  return (
    <div className="space-y-3">
      {!contacts && (
        <form
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            send(reveal, new FormData(e.currentTarget));
          }}
        >
          <input type="hidden" name="propertyId" value={propertyId} />
          <p className="mb-2 text-sm text-slate-600">
            Contacts are confidential. Showing them is recorded in the audit log.
          </p>
          <Button type="submit" variant="secondary" disabled={revealing}>
            {revealing ? 'Loading…' : 'Show contacts'}
          </Button>
        </form>
      )}
      {shown && !shown.ok && <Alert tone="error">{shown.error.message}</Alert>}
      {contacts && (
        <ul
          aria-label="Contacts"
          className="divide-y divide-slate-100"
          data-testid="property-contacts"
        >
          {contacts.length === 0 && (
            <li className="py-2 text-sm text-slate-600">No contacts yet.</li>
          )}
          {contacts.map((c) => (
            <li
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <div>
                <p className="font-medium text-slate-900">
                  {c.name}{' '}
                  <span className="text-xs text-slate-600">
                    ({PROPERTY_LABELS[c.relationship] ?? c.relationship})
                  </span>
                </p>
                {c.phone && <p className="text-slate-700">{c.phone}</p>}
                {c.email && <p className="text-slate-700">{c.email}</p>}
              </div>
              {canManage && (
                <form
                  onSubmit={(e: FormEvent<HTMLFormElement>) => {
                    e.preventDefault();
                    send(remove, new FormData(e.currentTarget));
                  }}
                >
                  <input type="hidden" name="contactId" value={c.id} />
                  <Button type="submit" variant="ghost" disabled={removing}>
                    Remove
                  </Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {removed && !removed.ok && <Alert tone="error">{removed.error.message}</Alert>}
      {canManage && contacts && (
        <form
          aria-label="Add a contact"
          className="space-y-3 border-t border-slate-100 pt-3"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            setLastAdd(added);
            const fd = new FormData(e.currentTarget);
            send(add, fd);
          }}
        >
          <input type="hidden" name="propertyId" value={propertyId} />
          {added?.ok && added !== lastAdd && <Alert tone="success">Contact added.</Alert>}
          {added && !added.ok && (
            <Alert tone="error">
              {added.error.message}
              {addErrors.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {addErrors.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="pc-name">
              <Input id="pc-name" name="name" maxLength={120} required />
            </Field>
            <Field label="Relationship" htmlFor="pc-rel">
              <Select id="pc-rel" name="relationship" defaultValue="OWNER">
                {CONTACT_RELATIONSHIPS.map((r) => (
                  <option key={r} value={r}>
                    {PROPERTY_LABELS[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Mobile (India)" htmlFor="pc-phone">
              <Input id="pc-phone" name="phone" inputMode="tel" maxLength={30} />
            </Field>
            <Field label="Email" htmlFor="pc-email">
              <Input id="pc-email" name="email" type="email" maxLength={254} />
            </Field>
          </div>
          <Button type="submit" disabled={adding}>
            {adding ? 'Saving…' : 'Add contact'}
          </Button>
        </form>
      )}
    </div>
  );
}
