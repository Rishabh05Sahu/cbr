import { z } from 'zod';
import { Alert } from '@/components/ui';
import { SignupForm } from './signup-form';

export default async function SignupPage({ searchParams }: PageProps<'/signup'>) {
  const sp = await searchParams;
  const parsed = z.uuid().safeParse(sp.invitation);
  if (!parsed.success) {
    return (
      <Alert tone="info">
        Accounts are created by invitation. Please use the link in your invitation email.
      </Alert>
    );
  }
  return <SignupForm invitationId={parsed.data} />;
}
