// Public legal pages (Google Play needs them at public URLs, ADR-0027): no sign-in required.
import type { ReactNode } from 'react';
import Link from 'next/link';
import { BrandMark, Wordmark } from '@/components/brand';

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <BrandMark size={44} />
          <Wordmark />
        </div>
        <article className="rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-sm sm:p-8 [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:mt-1 [&_p]:mt-2 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
          {children}
        </article>
        <p className="mt-4 text-center text-sm text-slate-500">
          <Link href="/privacy" className="underline">
            Privacy policy
          </Link>{' '}
          ·{' '}
          <Link href="/account-deletion" className="underline">
            Delete your account
          </Link>
        </p>
      </div>
    </main>
  );
}
