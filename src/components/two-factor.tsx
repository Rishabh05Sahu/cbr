'use client';
// Two-step verification UI (item D): enrolment with one-time recovery codes, recovery-code
// regeneration, authenticator replacement and (where the role allows it) turning 2FA off.
// Library endpoints are called through /api/auth (rate-limited, origin-checked); the
// authenticator replacement is a Server Action that checks password + second factor.
import { useRouter } from 'next/navigation';
import { useActionState, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { authClient, authErrorMessage } from '@/platform/auth/client';
import type { ActionResult } from '@/platform/errors';

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-4">
      <Alert tone="warn">
        Save these recovery codes somewhere safe (a password manager or a printed copy). Each code
        works once if you lose your phone. They are shown only now.
      </Alert>
      <ul
        className="grid grid-cols-2 gap-2 rounded bg-slate-100 p-3 font-mono text-sm"
        aria-label="Recovery codes"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have
        saved my recovery codes
      </label>
      <Button type="button" disabled={!saved} onClick={onDone}>
        Continue
      </Button>
    </div>
  );
}

const passwordField = (id: string) => (
  <Field label="Confirm your password" htmlFor={id}>
    <Input id={id} name="password" type="password" autoComplete="current-password" required />
  </Field>
);

export function TwoFactorEnrol({ doneHref }: { doneHref: string }) {
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'verify' | 'codes'>('password');
  const [secret, setSecret] = useState<{ uri: string; key: string; codes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    const { data, error } = await authClient.twoFactor.enable({ password });
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    if (data && 'totpURI' in data && data.totpURI) {
      setSecret({
        uri: data.totpURI,
        key: new URL(data.totpURI).searchParams.get('secret') ?? '',
        codes: data.backupCodes ?? [],
      });
      setStep('verify');
    }
  }

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    setStep('codes');
  }

  if (step === 'codes' && secret) {
    return (
      <RecoveryCodes
        codes={secret.codes}
        onDone={() => {
          router.push(doneHref as '/app');
          router.refresh();
        }}
      />
    );
  }

  if (step === 'verify' && secret) {
    return (
      <form onSubmit={verify} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}
        <p className="text-sm">
          In your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), add
          an account with this setup key, then enter the 6-digit code it shows.
        </p>
        <code className="block break-all rounded bg-slate-100 p-2 text-sm">{secret.key}</code>
        <p className="text-sm">
          On this phone?{' '}
          <a className="text-blue-800 underline" href={secret.uri}>
            Open in authenticator app
          </a>
        </p>
        <Field label="Code from the app" htmlFor="code">
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            autoComplete="one-time-code"
            required
          />
        </Field>
        <Button type="submit" disabled={pending}>
          Turn on
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={start} className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      {passwordField('tf-password')}
      <Button type="submit" disabled={pending}>
        Set up two-step verification
      </Button>
    </form>
  );
}

export function RegenerateRecoveryCodes() {
  const router = useRouter();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
    if (error) return setError(authErrorMessage(error));
    setCodes(data?.backupCodes ?? []);
  }

  if (codes)
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setCodes(null);
          router.refresh();
        }}
      />
    );
  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <Alert tone="error">{error}</Alert>}
      <p className="text-sm text-slate-700">New codes replace all your old ones.</p>
      {passwordField('rc-password')}
      <Button type="submit" variant="secondary">
        Generate new recovery codes
      </Button>
    </form>
  );
}

type ReplaceAction = (
  prev: ActionResult<unknown> | null,
  formData: FormData,
) => Promise<ActionResult<unknown>>;

export function ReplaceAuthenticator({
  action,
  nextHref,
}: {
  action: ReplaceAction;
  nextHref: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    async (prev: ActionResult<unknown> | null, fd: FormData) => {
      const r = await action(prev, fd);
      if (r.ok) router.push(nextHref as '/app');
      return r;
    },
    null,
  );
  return (
    <form action={formAction} className="space-y-3">
      {state && !state.ok && <Alert tone="error">{state.error.message}</Alert>}
      <p className="text-sm text-slate-700">
        New phone? Confirm your password and a code from your current app, or one of your recovery
        codes. You then set up the new phone straight away.
      </p>
      {passwordField('ra-password')}
      <Field label="Authenticator code or recovery code" htmlFor="ra-code">
        <Input id="ra-code" name="code" autoComplete="one-time-code" required maxLength={20} />
      </Field>
      <Button type="submit" variant="secondary" disabled={pending}>
        Replace authenticator
      </Button>
    </form>
  );
}

export function DisableTwoFactor() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    const { error } = await authClient.twoFactor.disable({ password });
    if (error) return setError(authErrorMessage(error));
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      {error && <Alert tone="error">{error}</Alert>}
      {passwordField('dis-password')}
      <Button type="submit" variant="danger">
        Turn off two-step verification
      </Button>
    </form>
  );
}

export function SignOutEverywhere() {
  const router = useRouter();
  return (
    <Button
      variant="secondary"
      onClick={async () => {
        await authClient.revokeSessions();
        router.push('/login?notice=signed-out');
      }}
    >
      Sign out of all devices
    </Button>
  );
}
