import Link from 'next/link';
import { Alert, Card, PageHeader } from '@/components/ui';
import { TwoFactorEnrol } from '@/components/two-factor';
import { pageUser } from '@/platform/auth/session';
import { twoFactorStatus } from '@/platform/auth/two-factor';

// Owners, Admins and platform staff are sent here until they enrol an authenticator (item D).
export default async function TwoFactorSetupPage() {
  const user = await pageUser();
  const status = await twoFactorStatus(user.id, user.platformRole);
  const done = user.platformRole === 'PLATFORM_ADMIN' ? '/platform' : '/app';
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="Two-step verification"
        description="Signing in needs your password and a code from an authenticator app on your phone."
      />
      {status.enabled ? (
        <Card title="Two-step verification is on">
          <p className="text-sm">
            Manage recovery codes or replace your phone in{' '}
            <Link className="text-blue-800 underline" href="/app/settings/profile">
              My profile
            </Link>
            .
          </p>
        </Card>
      ) : (
        <Card title="Set up your authenticator app">
          <div className="space-y-4">
            {status.mandatory && (
              <Alert tone="warn">
                Your role (Owner, Admin or platform staff) can see and change customer data, so
                two-step verification is required before you can continue.
              </Alert>
            )}
            <TwoFactorEnrol doneHref={done} />
          </div>
        </Card>
      )}
    </div>
  );
}
