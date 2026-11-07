'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { authClient, authErrorMessage } from '@/platform/auth/client';

export default function TwoFactorPage() {
  const router = useRouter();
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim();
    setPending(true);
    setError(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    router.push('/app');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Two-step verification</h1>
      <p className="text-sm text-slate-600">
        {useBackup
          ? 'Enter one of your recovery codes. Each code works once.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label={useBackup ? 'Recovery code' : 'Code'} htmlFor="code">
        <Input
          id="code"
          name="code"
          inputMode={useBackup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          required
          autoFocus
        />
      </Field>
      <Button type="submit" className="w-full" disabled={pending}>
        Verify
      </Button>
      <Button variant="ghost" className="w-full" onClick={() => setUseBackup(!useBackup)}>
        {useBackup ? 'Use authenticator code' : 'Lost your phone? Use a recovery code'}
      </Button>
    </form>
  );
}
