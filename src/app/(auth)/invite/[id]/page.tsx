import { z } from 'zod';
import { Alert } from '@/components/ui';
import { roleLabel } from '@/platform/email/templates';
import { getInvitationForRecipient } from '@/platform/auth/org-admin';
import { currentResolution, requestHeaders } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { enforce, RateLimited, RULES } from '@/platform/rate-limit';
import { InvitationActions } from './invitation-actions';

type Lookup =
  | { kind: 'ok'; inv: Awaited<ReturnType<typeof getInvitationForRecipient>> }
  | { kind: 'limited'; message: string }
  | { kind: 'unavailable' };

async function lookup(userId: string, id: string): Promise<Lookup> {
  try {
    await enforce(`invite-lookup:${userId}`, RULES.invitationLookup);
    return { kind: 'ok', inv: await getInvitationForRecipient(await requestHeaders(), id) };
  } catch (e) {
    if (e instanceof RateLimited) return { kind: 'limited', message: e.message };
    if (e instanceof DomainError) return { kind: 'unavailable' };
    throw e;
  }
}

export default async function InvitePage({ params }: PageProps<'/invite/[id]'>) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return <Alert tone="error">This invitation link is not valid.</Alert>;

  const { user } = await currentResolution();
  if (!user) {
    const next = encodeURIComponent(`/invite/${id}`);
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">You have been invited</h1>
        <p className="text-sm text-slate-600">
          Sign in or create an account with the email address this invitation was sent to.
        </p>
        <div className="flex flex-col gap-2">
          <a
            className="tap rounded-md bg-blue-900 px-3 py-2 text-center text-sm font-medium text-white"
            href={`/login?next=${next}`}
          >
            Sign in
          </a>
          <a
            className="rounded-md border border-slate-300 px-3 py-2 text-center text-sm font-medium"
            href={`/signup?invitation=${id}`}
          >
            Create an account
          </a>
        </div>
      </div>
    );
  }

  const result = await lookup(user.id, id);
  if (result.kind === 'limited') return <Alert tone="error">{result.message}</Alert>;
  if (result.kind === 'unavailable') {
    return (
      <Alert tone="error">
        This invitation is not available for {user.email}. It may have expired or been cancelled, or
        it was sent to another address.
      </Alert>
    );
  }
  const inv = result.inv;
  if (inv.status !== 'pending')
    return <Alert tone="info">This invitation has already been {inv.status}.</Alert>;
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Join {inv.organizationName}</h1>
      <p className="text-sm text-slate-600">
        {inv.inviterEmail} invited you as <strong>{roleLabel(inv.role)}</strong>. The invitation
        expires on{' '}
        {new Date(inv.expiresAt).toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })}
        .
      </p>
      {!user.emailVerified && (
        <Alert tone="info">Confirm your email address first, then reload this page.</Alert>
      )}
      <InvitationActions invitationId={id} />
    </div>
  );
}
