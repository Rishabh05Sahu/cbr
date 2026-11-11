import type { ReactNode } from 'react';
import { BrandLogo } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center bg-slate-50 bg-[radial-gradient(ellipse_at_top,var(--c-brand-100),transparent_60%)] px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <BrandLogo size={136} />
          <p className="mt-4 font-display text-2xl font-semibold tracking-wide text-blue-900">
            CBR Property CRM
          </p>
          <p className="mt-1 text-[0.6875rem] font-medium uppercase tracking-[0.25em] text-gold-600">
            Building trust · Creating futures
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-lg shadow-slate-900/5">
          {children}
        </div>
      </div>
    </main>
  );
}
