'use client';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { authClient, authErrorMessage } from '@/platform/auth/client';

/** Account creation for invitation holders only (the server refuses everyone else). */
export function SignupForm({ invitationId }: { invitationId: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const { error } = await authClient.signUp.email({
      name: String(fd.get('name') ?? ''),
      email: String(fd.get('email') ?? ''),
      password: String(fd.get('password') ?? ''),
      callbackURL: `/login?notice=verified&next=${encodeURIComponent(`/invite/${invitationId}`)}`,
    });
    if (error) return setError(authErrorMessage(error));
    setDone(true);
  }

  if (done) {
    return (
      <Alert tone="success">
        Check your inbox for a confirmation link. After confirming, sign in to accept the
        invitation. If you did not receive an email, make sure you used the address the invitation
        was sent to.
      </Alert>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Create your account</h1>
      <p className="text-sm text-slate-600">Use the email address your invitation was sent to.</p>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Full name" htmlFor="name">
        <Input id="name" name="name" autoComplete="name" required minLength={2} maxLength={100} />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 12 characters.">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </Field>
      <Button type="submit" className="w-full">
        Create account
      </Button>
    </form>
  );
}
