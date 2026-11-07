# Runbook: private Supabase Storage bucket for lead imports (Phase 2 M4)

The owner performs these steps by hand. The CRM never creates projects or buckets.

**Scope.** Supabase is used **only** for import files. The CRM database stays on Neon. Never put production credentials in chat, tickets, commits or `.env.example`.

## 1. Project

1. Use a Supabase project in the **Mumbai (ap-south-1)** region, so data stays in India (deployment-and-operations §1).
2. The Free plan is enough for the pilot, but:
   - objects are capped at 50 MB (the CRM uses 20 MB);
   - Free projects are **paused after a period of inactivity**, which would make imports fail with "storage temporarily unavailable" until the project is resumed;
   - consider a paid plan before production. That costs money and needs your separate approval.
3. Use a **separate project (or at least a separate bucket and key) for each environment**: local/dev, staging and production.

## 2. Bucket

In **Storage → New bucket**:

| Setting | Value |
|---|---|
| Name | `crm-imports` (or set `SUPABASE_IMPORT_BUCKET`) |
| Public bucket | **Off** |
| Restrict file upload size | **On, 20 MB**. Keep it equal to `IMPORT_MAX_BYTES` |
| Allowed MIME types | `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |

Do **not** add any `storage.objects` policies for the `anon` or `authenticated` roles:
- the server uses the secret key;
- browsers upload with a signed, single-object upload token, which needs no policy.

If the project was created with example policies, delete any that mention this bucket.

## 3. Keys and environment

1. In **Project Settings → API Keys**, create a **secret** key (`sb_secret_…`) for the CRM server. The legacy `service_role` key also works but cannot be rotated on its own.
2. Set these in the server's secret store, and in your local `.env` for development:

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | the secret key |
   | `SUPABASE_IMPORT_BUCKET` | `crm-imports` |
   | `IMPORT_MAX_BYTES` | `20971520` |

3. Never prefix any of these with `NEXT_PUBLIC_`. A unit test (`src/platform/storage/client-boundary.test.ts`) and ESLint fail if client code imports the storage gateway or the SDK.
4. `SUPABASE_URL` must also be present **at build time**. `next.config.ts` adds its origin, and only its origin, to the Content-Security-Policy `connect-src`, so the browser may PUT the file to the bucket.

## 4. Real-storage check (synthetic files only)

Run this once after §1–§3, before the M4 sign-off and again for each new environment. It uses only synthetic files, writes nothing to production, and needs no real customer data.

**Prerequisites:**
- **Bucket:** the private `crm-imports` bucket from §2. It allows only the two MIME types, has a 20 MB limit, and has no `storage.objects` policies for `anon` or `authenticated`.
- **`.env` (local) or the secret store:**
  - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (the secret key), from §3;
  - `CLEANUP_DATABASE_URL` for the **worker** only;
  - `crm_cleanup` provisioned with `node scripts/db/provision-cleanup-role.mjs --local <db>`.
- **Build:** `pnpm build` run **with `SUPABASE_URL` set**, so the CSP allows the browser PUT. A build made without it blocks the upload in the browser.
- **Running services:** the web app (`pnpm start`, or `pnpm dev`) and the worker (`pnpm worker:dev`) against the local `crm_dev`.
- **Test users:** one synthetic organisation with an Owner and a Sales Executive, plus a second synthetic organisation with its own Owner.

**Step 1: bucket probe (script).** Run `pnpm exec tsx scripts/storage-check/verify-bucket.ts`. Every line must say `PASS`. It checks:
- the signed grant names one object and contains no key;
- a browser-style PUT (no key) succeeds;
- replaying the token cannot overwrite, and the token does not work for another object;
- size, type and SHA-256 match after upload;
- public, authenticated-without-key and direct anonymous reads are refused;
- delete is idempotent, and an unrelated control object survives.

It writes two tiny objects under the probe org `00000000-0000-7000-8000-00000000c4ec` and removes them.

**Step 1b: bucket limits (dashboard).** Try to upload a file over 20 MB and a `.exe` (or any other type) into `crm-imports`. Both must be refused. The CRM checks this too, but the bucket must refuse on its own.

**Step 2: synthetic files.** Run `pnpm exec tsx scripts/storage-check/synthetic-files.ts <dir>`. This writes `synthetic-leads.csv` and `synthetic-leads.xlsx`: made-up rows, one bad phone, one in-file duplicate; the XLSX has a "Read me" and a "Leads" sheet.

**Step 3: in a real browser, as the Owner.** In DevTools → Network, keep "Preserve log" on.

| # | Do | Expected |
|---|---|---|
| 3.1 | **Leads → Import**, upload `synthetic-leads.csv` | The progress bar fills. The Network tab shows a PUT to `https://<ref>.supabase.co/storage/v1/object/upload/sign/crm-imports/orgs/<your-org>/imports/<id>/<32-hex>.csv?token=…` with **no** `Authorization` header. The page moves to "Reading file" and then "Map columns". No CSP error in the console |
| 3.2 | Search the page source, every JS file (Sources → search) and every response for the secret key's first 12 characters, `sb_secret`, `service_role` and `SUPABASE_SERVICE` | No match anywhere |
| 3.3 | Map columns (suggestions should already be right) and click **Check rows** | "Ready to import": 2 valid, 1 with problems, 1 same phone earlier in file. The problem rows show row numbers and messages, never the bad value |
| 3.4 | Tick the attestation and click **Import 2 rows** | "Completed with problems": 2 new leads, created by you. Download the problems CSV: row, column and message only |
| 3.5 | Upload `synthetic-leads.xlsx`, choose the **Leads** sheet, then map, check and import | The same results with the XLSX phones. The "Read me" sheet is never imported |
| 3.6 | Repeat 3.1 with the same CSV | Warning that the file was imported before; importing needs the extra tick; rows attach to the leads from 3.4 |
| 3.7 | In the bucket (dashboard), note the objects under `orgs/<your-org>/imports/` | One object per upload, all under your org, none named after the original file |

**Step 4: refusals.**

| # | Do | Expected |
|---|---|---|
| 4.1 | Sign out, then open `/app/leads/import` and `/app/leads/import/<id>` | Redirect to sign-in |
| 4.2 | As the Sales Executive, open the same URLs | 404 |
| 4.3 | As the Owner of the **other** organisation, open `/app/leads/import/<id>` and `/app/leads/import/<id>/issues.csv` | 404 |
| 4.4 | Copy the signed PUT URL from 3.1 and replay it (for example `curl -X PUT -H 'content-type: text/csv' --data-binary @synthetic-leads.csv '<url>'`) | Refused (4xx); the object is unchanged |

**Step 5: cleanup.**

| # | Do | Expected |
|---|---|---|
| 5.1 | In the dashboard, upload a **control** file outside `orgs/`, for example `manual-control/keep.csv` | It is never touched by the CRM |
| 5.2 | Start an import and **cancel** it after it reaches "Map columns". Also run a **dry run** to completion | Within about 10 minutes (one sweep), both files disappear from the bucket. The worker log shows `import file sweep` with `deleted ≥ 2` and `refused: 0` |
| 5.3 | Look at the completed imports from 3.4 and 3.5 | Their files are deleted within 24 h of finishing |
| 5.4 | Check the control file and any other bucket content | Unchanged |

Record the date, environment and the result of each step in `docs/PHASE-2-M4-REPORT.md`. **Do not** use real customer or brokerage files for this check; the pilot-file validation (P6) is separate.

## 5. Rotation and incidents

- **Rotate:** create a new secret key, update the server secret, redeploy web and worker, then delete the old key.
- **Suspected leak:** delete the key immediately, which stops all storage access. Then rotate as above. Review the bucket's object list for unexpected paths: every valid path has the form `orgs/<org-id>/imports/<import-id>/<32-hex>.csv|xlsx`.

## 6. Retention and manual sweep

Supabase Storage has no lifecycle rules. The CRM worker's cleanup sweep runs every 10 minutes when `CLEANUP_DATABASE_URL` (role `crm_cleanup`, see `scripts/db/provision-cleanup-role.mjs`) and the storage variables are set on the **worker**. It deletes:
- files of abandoned uploads and of imports left waiting, about 3 h after their last step (the job becomes EXPIRED);
- files of finished imports within 24 h (failed, cancelled and dry-run imports at the next sweep);
- files of paused imports about 24 h after the pause.

Without `CLEANUP_DATABASE_URL` the worker logs `import file cleanup disabled` and files stay. If files ever need removing by hand, delete only objects under `orgs/` in `crm-imports`, after confirming in **Leads → Import** that the import has ended.
