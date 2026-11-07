// Writes the SYNTHETIC M6 import corpus (not brokerage exports; does not satisfy P6) to
// pilot/synthetic-corpus/, plus manifest.json (size, SHA-256, expected counts per file). The
// content and expectations come from tests/support/import-corpus.ts; output is deterministic.
//
//   pnpm exec tsx scripts/pilot/generate-import-corpus.ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_LABEL, corpusFiles } from '../../tests/support/import-corpus';

const dir = join(process.cwd(), 'pilot', 'synthetic-corpus');
mkdirSync(dir, { recursive: true });
const manifest = {
  label: CORPUS_LABEL,
  generator:
    'scripts/pilot/generate-import-corpus.ts (definitions: tests/support/import-corpus.ts)',
  notP6:
    'These files are synthetic test data. They do not replace a representative anonymised export from the pilot brokerage (P6).',
  files: [] as unknown[],
};
for (const f of corpusFiles()) {
  const bytes = f.bytes();
  writeFileSync(join(dir, f.name), bytes);
  manifest.files.push({
    name: f.name,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...('sheet' in f ? { sheet: f.sheet } : {}),
    purpose: f.purpose,
    expected: f.expected,
  });
  console.log(`wrote ${f.name} (${bytes.byteLength.toLocaleString('en-IN')} bytes)`);
}
writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('wrote manifest.json');
