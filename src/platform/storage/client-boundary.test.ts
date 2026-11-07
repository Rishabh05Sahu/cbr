// Static guard for T9 (secrets exposure): client components never reach the storage gateway,
// the server environment or the storage SDK, and no secret is given a public env name.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function* sourceFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'generated') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

describe('storage secrets stay on the server', () => {
  const files = [...sourceFiles('src')].map((p) => ({ p, text: readFileSync(p, 'utf8') }));

  it('no client component imports the storage gateway, server env or storage SDK', () => {
    const offenders = files
      .filter(({ text }) => /^\s*['"]use client['"]/.test(text))
      .filter(({ text }) => /from\s+['"](@\/platform\/storage|@\/env|@supabase\/)/.test(text))
      .map(({ p }) => p);
    expect(offenders).toEqual([]);
  });

  it('no NEXT_PUBLIC_ variable names a storage key or secret', () => {
    const all = [...files, { p: '.env.example', text: readFileSync('.env.example', 'utf8') }];
    const offenders = all
      .filter(({ text }) => /NEXT_PUBLIC_\w*(SUPABASE|SERVICE|SECRET|KEY)/.test(text))
      .map(({ p }) => p);
    expect(offenders).toEqual([]);
  });
});
