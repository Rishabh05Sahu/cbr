'use client';
// FR-060: shows the masked numbers from the server and, on request, reveals them through the
// audited server action. A revealed number lives only in this component's state: it is gone when
// the user hides it, reloads or leaves the page. Revealing never permits contact.
import { useActionState, useState } from 'react';
import type { ActionResult } from '@/platform/errors';
import type { RevealedPhone } from '@/modules/leads';
import { revealLeadPhoneAction } from '@/modules/leads/actions';
import { Alert, Button } from '@/components/ui';

export function PhoneReveal({
  leadId,
  masked,
  canReveal,
}: {
  leadId: string;
  masked: { primary: string; alternate: string | null };
  canReveal: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionResult<RevealedPhone> | null, FormData>(
    revealLeadPhoneAction,
    null,
  );
  const [hidden, setHidden] = useState(false);
  const shown = state?.ok && !hidden ? state.data : null;
  return (
    <div className="space-y-2 sm:col-span-2">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-slate-500">Mobile</dt>
          <dd data-testid="phone-primary">{shown ? shown.primaryPhoneE164 : masked.primary}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Alternate</dt>
          <dd data-testid="phone-alternate">
            {(shown ? shown.alternatePhoneE164 : masked.alternate) ?? '—'}
          </dd>
        </div>
      </dl>
      {shown ? (
        <div className="space-y-2">
          {shown.contactStatus === 'DO_NOT_CONTACT' && (
            <Alert tone="error">
              Shown for reference only. This person asked not to be contacted.
            </Alert>
          )}
          <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span>
              Revealed and recorded in the audit log. {shown.remainingToday} reveals left today.
            </span>
            <Button type="button" variant="secondary" onClick={() => setHidden(true)}>
              Hide number
            </Button>
          </p>
        </div>
      ) : (
        canReveal && (
          <form
            action={(fd) => {
              setHidden(false);
              formAction(fd);
            }}
            className="space-y-2"
          >
            <input type="hidden" name="leadId" value={leadId} />
            {state && !state.ok && <Alert tone="error">{state.error.message}</Alert>}
            <Button type="submit" variant="secondary" disabled={pending}>
              {pending ? 'Revealing…' : 'Reveal number'}
            </Button>
            <p className="text-xs text-slate-600">
              Each reveal is recorded in the audit log and counts towards your daily limit.
            </p>
          </form>
        )
      )}
    </div>
  );
}
