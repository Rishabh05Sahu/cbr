// M5 §K: on a phone every top-level destination is reachable through the "Menu" disclosure
// (no hidden sideways scrolling), with 44 px tall links; the current page is marked. Rendered to
// static HTML (no DOM environment in this repo), with the router's pathname mocked.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/app/settings/custom-fields' }));
const { MainNav } = await import('./main-nav');

const links = [
  { href: '/app', label: 'Home' },
  { href: '/app/leads', label: 'Leads' },
  { href: '/app/settings/members', label: 'People' },
  { href: '/app/settings/custom-fields', label: 'Custom fields' },
  { href: '/app/settings/audit', label: 'Audit log' },
  { href: '/app/notifications', label: 'Notifications', badge: 3 },
];
const html = renderToStaticMarkup(createElement(MainNav, { links }));
const [mobile = '', desktop = ''] = html.split('</details>');

describe('MainNav', () => {
  it('puts every destination in a keyboard-operable Menu disclosure below desktop width', () => {
    expect(mobile).toMatch(/^<details[^>]*class="[^"]*lg:hidden/);
    expect(mobile).toContain('<summary');
    expect(mobile).toContain('Menu');
    for (const l of links) expect(mobile).toContain(`href="${l.href}"`);
    // Full-width, 44 px tall (min-h-11) targets; the summary itself is 44 px tall too.
    expect(mobile.match(/class="flex min-h-11 items-center/g)).toHaveLength(links.length);
    expect(mobile).toMatch(/<summary class="flex min-h-11/);
  });

  it('keeps the horizontal bar for desktop only, without sideways scrolling', () => {
    expect(desktop).toMatch(/<nav aria-label="Main" class="[^"]*hidden[^"]*lg:block/);
    expect(desktop).not.toContain('overflow-x-auto');
    for (const l of links) expect(desktop).toContain(`href="${l.href}"`);
  });

  it('marks the current page and names it on the closed menu', () => {
    expect(html.match(/aria-current="page"[^>]*>Custom fields/g)).toHaveLength(2);
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
    expect(mobile).toContain(
      'Menu<span class="font-normal text-slate-600"> · Custom fields</span>',
    );
  });

  it('shows the unread count with a screen-reader label', () => {
    expect(html).toContain('<span class="sr-only"> unread</span>');
  });
});
