'use client';
// Main navigation (M5 §K). Below the desktop breakpoint every destination sits in a "Menu"
// disclosure with full-width, 44 px tall links, instead of a sideways-scrolling bar that hid
// most destinations off-screen. <details>/<summary> is keyboard operable and announced as
// expandable without extra script; the menu closes after a destination is chosen. The current
// page is marked with aria-current in both layouts.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

export interface NavLink {
  href: string;
  label: string;
  badge?: number;
}

const isCurrent = (path: string, href: string) =>
  href === '/app' ? path === '/app' : path === href || path.startsWith(`${href}/`);

function Badge({ n }: { n: number }) {
  return (
    <span className="ml-1.5 rounded-full bg-gold-500 px-1.5 text-xs font-semibold text-white">
      {n > 99 ? '99+' : n}
      <span className="sr-only"> unread</span>
    </span>
  );
}

export function MainNav({ links }: { links: NavLink[] }) {
  const path = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [path]);
  const current = links.find((l) => isCurrent(path, l.href));

  return (
    <>
      <details ref={menu} id="main-menu" className="group mx-auto max-w-6xl px-4 pb-3 lg:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400 [&::-webkit-details-marker]:hidden">
          <span>
            Menu
            {current && <span className="font-normal text-slate-600"> · {current.label}</span>}
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <nav aria-label="Main">
          <ul className="mt-2 grid gap-1 rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm sm:grid-cols-2">
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href as '/app'}
                  aria-current={isCurrent(path, l.href) ? 'page' : undefined}
                  className="flex min-h-11 items-center rounded-lg px-3 text-sm text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400 aria-[current=page]:bg-blue-50 aria-[current=page]:font-semibold aria-[current=page]:text-blue-900"
                >
                  {l.label}
                  {l.badge ? <Badge n={l.badge} /> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </details>
      <nav aria-label="Main" className="mx-auto hidden max-w-6xl px-4 lg:block">
        <ul className="flex flex-wrap gap-1 pb-2.5 text-sm">
          {links.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href as '/app'}
                aria-current={isCurrent(path, l.href) ? 'page' : undefined}
                className="block whitespace-nowrap rounded-full px-3.5 py-1.5 text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400 aria-[current=page]:bg-blue-900 aria-[current=page]:font-medium aria-[current=page]:text-white"
              >
                {l.label}
                {l.badge ? <Badge n={l.badge} /> : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
