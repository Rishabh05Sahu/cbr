// Writes the synthetic files for the real-storage check (runbook §4): a CSV and an XLSX with
// made-up names and numbers only (no real people). Each has two importable rows, one row with
// a bad phone (to see a row problem) and one in-file duplicate.
//
//   pnpm exec tsx scripts/storage-check/synthetic-files.ts <output-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { xlsx } from '../../tests/support/spreadsheets';

const out = process.argv[2];
if (!out) {
  console.log('usage: synthetic-files.ts <output-dir>');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const stamp = Date.now().toString().slice(-6);
// Distinct phones per run, so a re-run is not an existing-lead duplicate of the last one.
const phone = (n: number) => `98${stamp}${String(n).padStart(2, '0')}`;

const rows = (p: (n: number) => string) => [
  ['Name', 'Mobile', 'City', 'Budget'],
  ['Synthetic Asha', p(1), 'Pune', '75 L'],
  ['Synthetic Ravi', p(2), 'Pune', '1.2 Cr'],
  ['Synthetic Bad Phone', '12345', 'Pune', ''],
  ['Synthetic Repeat', p(1), 'Pune', ''],
];

const csvRows = rows(phone);
writeFileSync(join(out, 'synthetic-leads.csv'), csvRows.map((r) => r.join(',')).join('\n') + '\n');
const xPhone = (n: number) => phone(n + 50);
writeFileSync(
  join(out, 'synthetic-leads.xlsx'),
  xlsx({
    'Read me': [['Synthetic test workbook: choose the "Leads" sheet']],
    Leads: rows(xPhone),
  }),
);
console.log(`wrote synthetic-leads.csv and synthetic-leads.xlsx to ${out}`);
