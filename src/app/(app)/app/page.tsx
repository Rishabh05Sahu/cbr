import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { pageContext } from '@/platform/auth/session';
import { can } from '@/platform/authz';
import { roleLabel } from '@/platform/email/templates';

export default async function HomePage() {
  const { user, ctx } = await pageContext();
  return (
    <>
      <PageHeader
        title={`Welcome, ${user.name}`}
        description={
          ctx.kind === 'member'
            ? `${roleLabel(ctx.pluginRole)} at ${ctx.orgName}`
            : `Support access to ${ctx.orgName}`
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card
          title="Leads, calling and follow-ups"
          description="Arrive in the next phases. This release sets up your organisation, people and teams."
        >
          <p className="text-sm text-slate-600">Nothing to do here yet.</p>
        </Card>
        <Card title="Get set up">
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <Link className="text-blue-800 underline" href="/app/settings/profile">
                Complete your profile and turn on two-step verification
              </Link>
            </li>
            {can(ctx, 'user.invite') && (
              <li>
                <Link className="text-blue-800 underline" href="/app/settings/members">
                  Invite your team
                </Link>
              </li>
            )}
            {can(ctx, 'team.manage') && (
              <li>
                <Link className="text-blue-800 underline" href="/app/settings/teams">
                  Create teams and assign team leads
                </Link>
              </li>
            )}
          </ul>
        </Card>
      </div>
    </>
  );
}
