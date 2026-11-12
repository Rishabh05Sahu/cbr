'use client';
// FR-080/081 on the lead page: Call opens the phone's dialer (tel:), WhatsApp opens the lead's
// chat (wa.me). Each tap is recorded on the server first (a call intent, never a call) and the
// server returns the link: Do-Not-Contact is refused, an Invalid number needs a confirmation, and
// with phone masking on the dial is a capped, audited reveal (ADR-0025). When the person comes
// back to this tab the page refreshes, so the FR-082 "how did it go?" prompt appears.
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button } from '@/components/ui';
import { recordCallIntentAction } from '@/modules/interactions/actions';
import type { IntentChannel } from '@/modules/interactions/call-intent-rules';
import type { ContactStatus } from '@/modules/leads/contactability';

const checkboxClass = 'mt-0.5 h-5 w-5 shrink-0 rounded border-slate-300';

export function CallLaunchers({
  leadId,
  contactStatus,
  hasAlternate,
  masked,
}: {
  leadId: string;
  contactStatus: ContactStatus;
  hasAlternate: boolean;
  masked: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [numberKind, setNumberKind] = useState<'PRIMARY' | 'ALTERNATE'>('PRIMARY');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ channel: IntentChannel; href: string } | null>(null);
  // armed: a link was opened; away: the tab was hidden after that.
  const armed = useRef(false);
  const away = useRef(false);

  // Back from the dialer or WhatsApp: refresh once so the outcome prompt shows.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && armed.current) away.current = true;
      if (document.visibilityState === 'visible' && away.current) {
        armed.current = false;
        away.current = false;
        router.refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [router]);

  if (contactStatus === 'DO_NOT_CONTACT')
    return (
      <p className="text-sm text-slate-700" data-testid="launchers-blocked">
        This lead asked not to be contacted, so Call and WhatsApp are switched off.
      </p>
    );

  const invalid = contactStatus === 'INVALID';
  const tap = (channel: IntentChannel) => {
    if (pending) return;
    setError(null);
    const fd = new FormData();
    fd.set('leadId', leadId);
    fd.set('channel', channel);
    fd.set('numberKind', numberKind);
    if (confirmed) fd.set('confirmInvalidNumber', 'on');
    startTransition(async () => {
      const r = await recordCallIntentAction(fd);
      if (!r.ok) {
        setError(r.error.message);
        return;
      }
      setOpened({ channel, href: r.data.href });
      armed.current = true;
      if (channel === 'PHONE_NATIVE') {
        window.location.href = r.data.href;
      } else {
        // A new tab keeps the CRM open on a computer; on a phone the link opens the app.
        const w = window.open(r.data.href, '_blank');
        if (w) w.opener = null;
        else window.location.href = r.data.href;
      }
    });
  };

  return (
    <div className="space-y-3" data-testid="call-launchers">
      {hasAlternate && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <legend className="sr-only">Which number</legend>
          {(['PRIMARY', 'ALTERNATE'] as const).map((k) => (
            <label key={k} className="tap inline-flex items-center gap-2">
              <input
                type="radio"
                name="numberKind"
                value={k}
                checked={numberKind === k}
                onChange={() => setNumberKind(k)}
                className="h-5 w-5"
              />
              {k === 'PRIMARY' ? 'Mobile' : 'Alternate'}
            </label>
          ))}
        </fieldset>
      )}
      {invalid && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>This lead&apos;s number is marked invalid. Contact them anyway.</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending || (invalid && !confirmed)}
          onClick={() => tap('PHONE_NATIVE')}
        >
          Call
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || (invalid && !confirmed)}
          onClick={() => tap('WHATSAPP_APP')}
        >
          WhatsApp
        </Button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {opened && !error && (
        <p className="text-xs text-slate-600">
          {opened.channel === 'PHONE_NATIVE' ? 'Opening the dialer.' : 'Opening WhatsApp.'} If
          nothing opened,{' '}
          <a
            href={opened.href}
            target={opened.channel === 'WHATSAPP_APP' ? '_blank' : undefined}
            rel="noopener noreferrer"
            className="underline"
          >
            tap here
          </a>
          . Come back to this page afterwards to log how it went.
        </p>
      )}
      <p className="text-xs text-slate-600">
        Opens your phone&apos;s dialer or WhatsApp. The CRM records that you tapped, not a call.
        {masked && ' The number is masked: each tap counts as a reveal and is recorded.'}
      </p>
    </div>
  );
}
