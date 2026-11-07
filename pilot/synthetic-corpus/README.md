# Synthetic import corpus (M6): SYNTHETIC TEST DATA, NOT BROKERAGE EXPORTS

Every file in this folder is **fabricated** and generated deterministically by
`scripts/pilot/generate-import-corpus.ts`. The definitions and expected outcomes are in
`tests/support/import-corpus.ts`:

- names are "Synthetic …";
- e-mails use the reserved `example.test` domain;
- phone numbers come from made-up local test blocks that are never contacted.

**These files do not satisfy P6.** P6 needs a representative, anonymised export from the real pilot brokerage, and these files are not one. Do not upload them to the real storage bucket, and do not present them as customer data.

| File                       | Rows               | What it exercises                                                                                                                                                                                                             |
| -------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corpus_custom_fields.csv` | 12                 | Required and strictly typed custom fields (text, number, date, yes/no, single and multiple choice), with every custom-field failure code. Also an invalid phone, an empty row and an in-file duplicate                        |
| `corpus_multisheet.xlsx`   | 150 per lead sheet | Sheet selection ("Read me", "Leads Q3", "Leads Q4"), a second header vocabulary, numeric phone cells                                                                                                                          |
| `corpus_variants.csv`      | 500                | A third header vocabulary. Phones written as `+91 …`, `0…`, `91-…`, spaced and plain. Budgets written as L, Cr, Lakh, crore, Indian digit grouping (`85,00,000/-`) and plain rupees                                           |
| `corpus_large_100k.csv`    | 100,000            | 19,950,650 bytes, just under the 20 MiB (20,971,520-byte) limit. In every 1,000 rows: 1 invalid phone, 1 empty row, 1 in-file duplicate, and 1 row reusing a phone seeded in the load-test org (an existing-lead match there) |
| `corpus_xlsx_20k.xlsx`     | 20,000             | The same mix as XLSX, with numeric phone and budget cells                                                                                                                                                                     |
| `manifest.json`            | —                  | Size, SHA-256, sheet and expected counts per file                                                                                                                                                                             |

The M4 fixture (`pilot/anonymised/synthetic_pilot_leads.csv/.xlsx`, 29 hand-written cases) still covers the individual normalisation edge cases: every phone, budget and value failure code.

**How the corpus is checked**

- `tests/support/import-corpus.test.ts` (unit, no database) runs every file through the real file check, parser, mapping suggestion, row validation and in-file duplicate detection, and compares the outcomes with the definitions. It also checks that a file one byte over the limit is refused.
- `scripts/perf/import-run.mts` imports the files through the real job on the isolated `crm_perf` database (seeded 250k-lead org). It checks the exact counts, existing-lead matches, a crash inside a batch followed by resume, and re-upload of the same file. See `docs/PHASE-2-M6-LOAD-TEST-PLAN.md`.

Regenerate with `pnpm exec tsx scripts/pilot/generate-import-corpus.ts`. The output is byte-identical every time.
