import { ActionFormButton } from '@/components/action-form-button';
import { Alert, Card, EmptyState, PageHeader } from '@/components/ui';
import { listMyMemberships } from '@/platform/auth/context';
import { currentResolution, pageUser } from '@/platform/auth/session';
import { roleLabel } from '@/platform/email/templates';
import { switchOrganizationAction } from '@/modules/organizations/actions';

const REASONS: Record<string, string> = {
  MEMBERSHIP_INACTIVE: 'Your access to the selected organisation is suspended or has ended.',
  ORG_SUSPENDED: 'The selected organisation is currently suspended.',
  NOT_A_MEMBER: 'You do not have access to the selected organisation.',
};

export default async function SelectOrgPage() {
  const user = await pageUser();
  const r = await currentResolution();
  const memberships = await listMyMemberships(user.id);
  const reason = !r.ok && r.reason in REASONS ? REASONS[r.reason] : null;
  return (
    <>
      <PageHeader title="Choose an organisation" />
      {reason && (
        <div className="mb-4">
          <Alert tone="error">{reason}</Alert>
        </div>
      )}
      <Card>
        {memberships.length === 0 ? (
          <EmptyState>
            You are not a member of any organisation yet. Ask your administrator for an invitation.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {memberships.map((m) => (
              <li key={m.orgId} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">{m.orgName}</p>
                  <p className="text-sm text-slate-600">{roleLabel(m.role)}</p>
                </div>
                <ActionFormButton
                  action={switchOrganizationAction}
                  fields={{ orgId: m.orgId }}
                  label="Open"
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
