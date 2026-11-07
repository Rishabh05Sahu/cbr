// Writes the SYNTHETIC pilot fixtures (not brokerage exports) to pilot/anonymised/:
//   synthetic_pilot_leads.csv   – Excel "CSV UTF-8" style (BOM, CRLF), one header row + cases
//   synthetic_pilot_leads.xlsx  – sheets "Read me" and "Leads" (rows on "Leads")
// The content and the expected outcome of every row come from tests/support/pilot-fixture.ts.
//
//   pnpm exec tsx scripts/pilot/generate-synthetic-fixtures.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectedCounts, fixtureCsv, fixtureXlsx } from '../../tests/support/pilot-fixture';

const dir = join(process.cwd(), 'pilot', 'anonymised');
const files = [
  ['synthetic_pilot_leads.csv', fixtureCsv()],
  ['synthetic_pilot_leads.xlsx', fixtureXlsx()],
] as const;
for (const [name, bytes] of files) {
  writeFileSync(join(dir, name), bytes);
  console.log(`wrote ${name} (${bytes.byteLength} bytes)`);
}
console.log('expected per file:', JSON.stringify(expectedCounts('csv')));
