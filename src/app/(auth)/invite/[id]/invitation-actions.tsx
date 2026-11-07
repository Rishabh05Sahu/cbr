'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { authClient, authErrorMessage } from '@/platform/auth/client';

export function InvitationActions({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function accept() {
    setPending(true);
    setError(null);
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId });
    if (error) {
      setPending(false);
      return setError(authErrorMessage(error));
    }
    const orgId = data?.member.organizationId;
    if (orgId) await authClient.organization.setActive({ organizationId: orgId });
    router.push('/app');
    router.refresh();
  }

  async function decline() {
    setPending(true);
    const { error } = await authClient.organization.rejectInvitation({ invitationId });
    setPending(false);
    if (error) return setError(authErrorMessage(error));
    router.push('/app/select-org');
  }

  return (
    <div className="space-y-3">
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex gap-2">
        <Button onClick={accept} disabled={pending}>
          Accept invitation
        </Button>
        <Button variant="secondary" onClick={decline} disabled={pending}>
          Decline
        </Button>
      </div>
    </div>
  );
}
