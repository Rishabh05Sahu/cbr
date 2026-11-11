import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { BrandMark, Wordmark } from '@/components/brand';
import { MainNav } from '@/components/main-nav';
import { QuickNav } from '@/components/quick-nav';
import { SignOutButton } from '@/components/sign-out-button';
import { ThemeToggle } from '@/components/theme-toggle';
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

/** The phone bottom bar, in priority order (only those the person may open; at most four). */
const QUICK = [
  { href: '/app', label: 'Home' },
  { href: '/app/my-day', label: 'My Day' },
  { href: '/app/leads', label: 'Leads' },
  { href: '/app/dashboard', label: 'Dashboard' },
  { href: '/app/visits', label: 'Visits' },
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const r = await currentResolution();
  if (!r.user) redirect('/login');
  const ctx = r.ok ? r.ctx : null;
  const links = NAV.filter((n) => !n.permission || (ctx && can(ctx, n.permission)));
  const unread = ctx ? await unreadCount(ctx) : 0;

  // Phones: the destinations used all day sit in a bottom bar (at most four, by permission).
  const quick = QUICK.flatMap((q) => links.filter((l) => l.href === q.href).map(() => q)).slice(
    0,
    4,
  );

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sticky on desktop only: on a phone the open menu can be taller than the screen. */}
      <header className="z-30 border-b border-slate-200 bg-white/95 backdrop-blur lg:sticky lg:top-0">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/app"
              className="flex shrink-0 items-center gap-2.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400"
              aria-label="CBR Property CRM home"
            >
              <BrandMark size={40} />
              <span className="hidden md:block">
                <Wordmark />
              </span>
            </Link>
            {ctx && (
              <Link
                href="/app/select-org"
                className="tap min-w-0 truncate rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-sm text-slate-700 hover:border-gold-400 hover:text-slate-900"
                title="Switch organisation"
              >
                {ctx.orgName}
              </Link>
            )}
            {ctx?.kind === 'support' && <Badge tone="warn">Support access · read-only</Badge>}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-sm text-slate-700">
            <span className="hidden font-medium text-slate-900 lg:inline">{r.user.name}</span>
            {ctx?.kind === 'member' && (
              <span className="hidden sm:inline">
                <Badge>{roleLabel(ctx.pluginRole)}</Badge>
              </span>
            )}
            {r.user.platformRole === 'PLATFORM_ADMIN' && (
              <Link href="/platform" className="tap underline">
                Platform
              </Link>
            )}
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
        <div aria-hidden="true" className="gold-rule h-px" />
        {ctx && (
          <div className="pt-2.5">
            <MainNav
              links={[
                ...links.map(({ href, label }) => ({ href, label })),
                ...(ctx.kind === 'member'
                  ? [{ href: '/app/notifications', label: 'Notifications', badge: unread }]
                  : []),
              ]}
            />
          </div>
        )}
      </header>
      <main className="mx-auto max-w-6xl px-4 pt-6 pb-28 lg:pb-10">{children}</main>
      {ctx && quick.length > 0 && <QuickNav links={quick} />}
    </div>
  );
}
