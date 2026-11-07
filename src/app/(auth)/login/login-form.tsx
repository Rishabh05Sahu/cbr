'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { authClient, authErrorMessage } from '@/platform/auth/client';

/** Only same-site relative paths are honoured as a post-login destination. */
function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';
}

export function LoginForm({
  next,
  notice,
}: {
  next?: string | undefined;
  notice?: string | undefined;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({
      email: String(fd.get('email') ?? ''),
      password: String(fd.get('password') ?? ''),
    });
    setPending(false);
    if (error) {
      setError(
        error.status === 403
          ? 'Please confirm your email address first. We have sent you a new confirmation link.'
          : authErrorMessage(error),
      );
      return;
    }
    if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return; // client plugin navigates
    router.push(safeNext(next) as '/app');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <h1 className="text-lg font-semibold">Sign in</h1>
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="text-center text-sm">
        <a href="/forgot-password" className="text-blue-800 underline">
          Forgot password?
        </a>
      </p>
    </form>
  );
}
