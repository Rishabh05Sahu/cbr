import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md p-10 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-slate-600">
        It may have moved, or you may not have access to it.
      </p>
      <Link className="mt-4 inline-block text-blue-800 underline" href="/app">
        Go to the app
      </Link>
    </main>
  );
}
