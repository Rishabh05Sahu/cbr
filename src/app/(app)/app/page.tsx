import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { pageContext } from '@/platform/auth/session';
import { can, type Permission } from '@/platform/authz';
import { roleLabel } from '@/platform/email/templates';

/** Home: shortcuts to the areas this person may open (the same permissions as the menu). */
const AREAS: { href: string; title: string; text: string; permission: Permission }[] = [
  {
    href: '/app/my-day',
    title: 'My Day',
    text: 'Follow-ups and tasks due today, overdue and coming up.',
    permission: 'task.read',
  },
  {
    href: '/app/leads',
    title: 'Leads',
    text: 'Search, filter and work your enquiries.',
    permission: 'lead.read',
  },
  {
    href: '/app/dashboard',
    title: 'Dashboard',
    text: 'Team and personal figures, with the records behind each one.',
    permission: 'report.read',
  },
  {
    href: '/app/visits',
    title: 'Site visits',
    text: 'Upcoming and recent visits, and what happened.',
    permission: 'site_visit.read',
  },
  {
    href: '/app/calendar',
    title: 'Calendar',
    text: 'Your tasks and meetings by day and week.',
    permission: 'task.read',
  },
  {
    href: '/app/properties',
    title: 'Properties',
    text: 'Listings and inventory.',
    permission: 'property.read',
  },
];

export default async function HomePage() {
  const { user, ctx } = await pageContext();
  const areas = AREAS.filter((a) => can(ctx, a.permission));
  const setup = [
    {
      show: true,
      href: '/app/settings/profile',
      text: 'Complete your profile and turn on two-step verification',
    },
    { show: can(ctx, 'user.invite'), href: '/app/settings/members', text: 'Invite your team' },
    {
      show: can(ctx, 'team.manage'),
      href: '/app/settings/teams',
      text: 'Create teams and assign team leads',
    },
  ].filter((s) => s.show);
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
      {areas.length > 0 && (
        <ul className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {areas.map((a) => (
            <li key={a.href}>
              <Link
                href={a.href as '/app'}
                className="group flex h-full flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-900/5 transition hover:-translate-y-0.5 hover:border-gold-400 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400"
              >
                <span className="flex items-center justify-between font-semibold text-blue-900">
                  {a.title}
                  <span
                    aria-hidden="true"
                    className="text-gold-500 transition-transform group-hover:translate-x-0.5"
                  >
                    →
                  </span>
                </span>
                <span className="mt-1 text-sm text-slate-600">{a.text}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Card title="Get set up">
        <ul className="space-y-1 text-sm">
          {setup.map((s) => (
            <li key={s.href}>
              <Link
                className="tap text-blue-800 underline underline-offset-2 hover:text-blue-900"
                href={s.href as '/app'}
              >
                {s.text}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
