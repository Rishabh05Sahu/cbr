import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { MainNav } from '@/components/main-nav';
import { SignOutButton } from '@/components/sign-out-button';
import { Badge } from '@/components/ui';
import { unreadCount } from '@/modules/notifications';
import { currentResolution } from '@/platform/auth/session';
import { can, type Permission } from '@/platform/authz';
import { roleLabel } from '@/platform/email/templates';

export const dynamic = 'force-dynamic';

const NAV: { href: string; label: string; permission?: Permission; ownerOnly?: boolean }[] = [
  { href: '/app', label: 'Home' },
  { href: '/app/dashboard', label: 'Dashboard', permission: 'report.read' },
  { href: '/app/my-day', label: 'My Day', permission: 'task.read' },
  { href: '/app/calendar', label: 'Calendar', permission: 'task.read' },
  { href: '/app/leads', label: 'Leads', permission: 'lead.read' },
  { href: '/app/properties', label: 'Properties', permission: 'property.read' },
  { href: '/app/visits', label: 'Site visits', permission: 'site_visit.read' },
  { href: '/app/scripts', label: 'Scripts', permission: 'script.read' },
  { href: '/app/settings/members', label: 'People', permission: 'user.read' },
  { href: '/app/settings/teams', label: 'Teams', permission: 'team.read' },
  { href: '/app/settings/organization', label: 'Organisation', permission: 'org.settings.read' },
  {
    href: '/app/settings/custom-fields',
    label: 'Custom fields',
    permission: 'org.settings.manage',
  },
  {
    href: '/app/settings/lead-sources',
    label: 'Lead sources',
    permission: 'org.settings.manage',
  },
  {
    href: '/app/settings/lead-tags',
    label: 'Lead tags',
    permission: 'org.settings.manage',
  },
  { href: '/app/settings/audit', label: 'Audit log', permission: 'audit.read' },
  {
    href: '/app/settings/support-access',
    label: 'Support access',
    permission: 'support_access.approve',
  },
  { href: '/app/settings/profile', label: 'My profile' },
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const r = await currentResolution();
  if (!r.user) redirect('/login');
  const ctx = r.ok ? r.ctx : null;
  const links = NAV.filter((n) => !n.permission || (ctx && can(ctx, n.permission)));
  const unread = ctx ? await unreadCount(ctx) : 0;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/app" className="tap font-semibold text-blue-900">
              CBR Property CRM
            </Link>
            {ctx && (
              <Link
                href="/app/select-org"
                className="tap text-sm text-slate-700 underline-offset-2 hover:underline"
                title="Switch organisation"
              >
                {ctx.orgName}
              </Link>
            )}
            {ctx?.kind === 'support' && <Badge tone="warn">Support access · read-only</Badge>}
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <span className="hidden sm:inline">{r.user.name}</span>
            {ctx?.kind === 'member' && <Badge>{roleLabel(ctx.pluginRole)}</Badge>}
            {r.user.platformRole === 'PLATFORM_ADMIN' && (
              <Link href="/platform" className="tap underline">
                Platform
              </Link>
            )}
            <SignOutButton />
          </div>
        </div>
        {ctx && (
          <MainNav
            links={[
              ...links.map(({ href, label }) => ({ href, label })),
              ...(ctx.kind === 'member'
                ? [{ href: '/app/notifications', label: 'Notifications', badge: unread }]
                : []),
            ]}
          />
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
