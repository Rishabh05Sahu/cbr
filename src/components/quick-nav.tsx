'use client';
// Phones and tablets: a bottom bar with the few destinations used all day (thumb reach), plus
// "Menu", which opens the full menu at the top of the page. Desktop uses the header bar only.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { NavLink } from './main-nav';

const isCurrent = (path: string, href: string) =>
  href === '/app' ? path === '/app' : path === href || path.startsWith(`${href}/`);

const svg = (d: ReactNode) => (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {d}
  </svg>
);
const ICONS: Record<string, ReactNode> = {
  '/app': svg(<path d="M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5h4v5" />),
  '/app/dashboard': svg(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />),
  '/app/my-day': svg(
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18M8 15l2.5 2.5L16 13" />
    </>,
  ),
  '/app/leads': svg(
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20c-.4-2-1.4-3.6-2.9-4.6" />
    </>,
  ),
  '/app/visits': svg(
    <>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>,
  ),
};
const MENU = svg(<path d="M4 7h16M4 12h16M4 17h16" />);

export function QuickNav({ links }: { links: NavLink[] }) {
  const path = usePathname();
  const openMenu = () => {
    const menu = document.getElementById('main-menu');
    if (menu instanceof HTMLDetailsElement) menu.open = true;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    menu?.querySelector('summary')?.focus({ preventScroll: true });
  };
  const item =
    'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-400';
  return (
    <nav
      aria-label="Quick"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgb(0_0_0/0.06)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto flex max-w-xl">
        {links.map((l) => {
          const on = isCurrent(path, l.href);
          return (
            <li key={l.href} className="flex flex-1">
              <Link
                href={l.href as '/app'}
                aria-current={on ? 'page' : undefined}
                className={`${item} ${on ? 'text-blue-900' : 'text-slate-500 hover:text-slate-800'}`}
              >
                <span className={`rounded-full px-3 py-0.5 ${on ? 'bg-blue-100' : ''}`}>
                  {ICONS[l.href] ?? MENU}
                </span>
                {l.label}
              </Link>
            </li>
          );
        })}
        <li className="flex flex-1">
          <button
            type="button"
            onClick={openMenu}
            className={`${item} text-slate-500 hover:text-slate-800`}
          >
            <span className="px-3 py-0.5">{MENU}</span>
            Menu
          </button>
        </li>
      </ul>
    </nav>
  );
}
