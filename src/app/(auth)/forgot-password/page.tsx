'use client';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { authClient, authErrorMessage } from '@/platform/auth/client';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email') ?? '');
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    // Same message whether or not the account exists (no enumeration); only throttling is surfaced.
    if (error?.status === 429) return setError(authErrorMessage(error));
    setSent(true);
  }

  if (sent) {
    return (
      <Alert tone="success">
        If an account exists for that address, we have sent a link to reset the password. It expires
        in 30 minutes.
      </Alert>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Reset your password</h1>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </Field>
      <Button type="submit" className="w-full">
        Send reset link
      </Button>
    </form>
  );
}
