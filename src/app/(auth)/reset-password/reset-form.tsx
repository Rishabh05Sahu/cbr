'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { authClient, authErrorMessage } from '@/platform/auth/client';

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const newPassword = String(fd.get('password') ?? '');
    if (newPassword !== String(fd.get('confirm') ?? ''))
      return setError('The passwords do not match.');
    const { error } = await authClient.resetPassword({ newPassword, token });
    if (error) return setError(authErrorMessage(error));
    router.push('/login?notice=reset');
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="New password" htmlFor="password" hint="At least 12 characters.">
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
      <Field label="Confirm password" htmlFor="confirm">
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </Field>
      <Button type="submit" className="w-full">
        Set password
      </Button>
    </form>
  );
}
