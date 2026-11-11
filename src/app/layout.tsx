import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { THEME_SCRIPT } from '@/components/theme-script';
import './globals.css';

export const metadata: Metadata = {
  title: 'CBR Property CRM',
  description: 'Sales CRM for Indian real estate brokerages',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f6f1' },
    { media: '(prefers-color-scheme: dark)', color: '#0e120f' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme script sets the `dark` class before React hydrates, so <html> may differ.
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
