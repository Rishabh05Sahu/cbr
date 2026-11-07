import { Alert } from '@/components/ui';
import { ResetForm } from './reset-form';

export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  const sp = await searchParams;
  const token = typeof sp.token === 'string' ? sp.token : null;
  if (!token || sp.error) {
    return (
      <Alert tone="error">
        This reset link is invalid or has expired.{' '}
        <a className="underline" href="/forgot-password">
          Request a new one
        </a>
        .
      </Alert>
    );
  }
  return <ResetForm token={token} />;
}
