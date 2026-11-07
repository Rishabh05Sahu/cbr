# Phase 2 M4 (lead import): implementation report

> 2026-10-24. Local and uncommitted. Synthetic data only. **Status: M4 is implemented; the real-storage acceptance (runbook §4) PASSED against the real Supabase bucket; the importer PASSED self-generated synthetic pilot fixtures. M4 is still NOT signed off: P6 (validation against a real brokerage's anonymised export) is outstanding.** Migration `0005_imports` is applied to the local `crm_test` and `crm_dev` databases only (no Neon or managed database). See "Final verification" below.

## Final verification (crm_dev and real-storage preparation)

### Local `crm_dev`: migrated (owner-approved)

| Step | Result |
|---|---|
| **Target proof** | `DATABASE_MIGRATOR_URL` resolves to `crm_migrator@127.0.0.1:55432/crm_dev`. Through that connection, the server's start time (`2026-10-23 04:49:12.867331+00`) and system identifier (`7698432437111361579`) match those read with `docker exec` inside `cbr-crm-postgres-1`, whose port is mapped only to `127.0.0.1:55432`. PostgreSQL 18.6 (Debian). It is the local Docker cluster, not Neon |
| **Contents before the change** | Migrations 0001–0002 only. **0 rows in every table** (`user`, `organization`, membership, audit, outbox…). Nothing to lose; no reset was needed or done |
| **Cleanup URL** | `CLEANUP_DATABASE_URL` added to `.env` (value not shown), built from the existing `CRM_CLEANUP_PASSWORD`. Checked: user `crm_cleanup`, `127.0.0.1:55432/crm_dev`, password equal to `CRM_CLEANUP_PASSWORD` |
| **Provisioning** | `node scripts/db/provision-cleanup-role.mjs --local crm_dev`: "existing role, password aligned" (the role is cluster-wide, from `crm_test`); `CONNECT` on `crm_dev` granted. Verification row `f\|f\|t\|f\|0`; the URL logs in as `crm_cleanup` to `crm_dev` |
| **Migration** | `prisma migrate deploy`, guarded to local `crm_dev`, applied **0003_leads, 0004_assignment, 0005_imports** (pending only; no reset; no applied migration modified) |
| **Record** | `_prisma_migrations`: 0001–0005 all finished, none rolled back. Checksums are identical to `crm_test` |
| **Security objects** | `app.import_files_due(integer)`: owner `crm_definer`, SECURITY DEFINER, `search_path=pg_catalog, pg_temp`, ACL `{crm_definer=X, crm_cleanup=X}`.<br>`app.import_job_guard()` trigger enabled.<br>RLS enabled and forced on all 25 tables, with the same policies on the import tables as on `crm_test`.<br>`crm_cleanup` has no table or column grants: `USAGE` on schema `app` only, no `CREATE` |
| **Schema equality** | A schema-only dump of `crm_dev` and `crm_test` (database names and PG 18 `\restrict` tokens normalised) is **identical**: 3,721 lines, 25 tables, 76 policies, 9 functions, 1 trigger, 183 GRANT/REVOKE statements. The schema-level results of the 217 integration and 71 e2e tests on `crm_test` therefore apply to `crm_dev`'s schema |
| **Live role probes on `crm_dev`** (read-only, no writes) | **23/23 PASS**:<br>• `crm_cleanup` logs in and runs the function (3 columns);<br>• no elevated attributes, NOINHERIT, no memberships, owns nothing;<br>• 42501 on all 25 tables; exactly one executable `app` function;<br>• cannot `SET ROLE` to `crm_definer`, `crm_app`, `crm_auth`, `crm_platform`, `crm_migrator` or `postgres`;<br>• cannot create in `public` or `app`.<br>`crm_app`, `crm_auth` and `crm_platform` cannot run the function or `SET ROLE crm_cleanup`. `crm_auth` and `crm_platform` cannot read `import_job`. `crm_app` without a tenant sees 0 jobs. No definer function `crm_app` may call reads `import_job`.<br>`crm_dev` still has 0 rows afterwards |
| **Not run on `crm_dev`** | The integration and e2e suites. They are hard-wired to `crm_test` and their setup **truncates** the database, so they must never point at `crm_dev`. The schema-equality and live-probe checks above replace them |

Observation, not changed: like every role, `crm_cleanup` can connect to the default `postgres` maintenance database. That is PostgreSQL's default `CONNECT` grant to `PUBLIC` there; that database has no CRM tables.

### Synthetic pilot-fixture validation, 2026-10-24 (NOT P6)

No brokerage export was supplied (two P6 attempts found an empty folder), so on the owner's instruction the importer was validated against **self-generated synthetic fixtures**.

**This is not P6.** These files prove the importer handles the scenarios below. They do **not** prove compatibility with a real brokerage's headers or value formats.

**Fixtures** (generated, git-ignored, in `pilot/anonymised/`, labelled in `SYNTHETIC_FIXTURES.md`):

| File | Size | Shape |
|---|---|---|
| `synthetic_pilot_leads.csv` | 2,231 B | Excel "CSV UTF-8" style (BOM, CRLF, quoted cells); 22 columns × 29 data rows |
| `synthetic_pilot_leads.xlsx` | 3,418 B | Sheets `Read me` (first) and `Leads`; 21 columns × 29 data rows on `Leads` |

**Values.** All values are fabricated: `Synthetic Lead NNN`, `@example.test` addresses, invented notes, and mobile numbers in a made-up `90000…` series (local tests only; never contacted). One definition, `tests/support/pilot-fixture.ts`, drives the files (`scripts/pilot/generate-synthetic-fixtures.ts`) and every expected outcome, so the two cannot drift.

**Headers tested** (only fields the importer supports):

| Variant | Headers | Expected mapping |
|---|---|---|
| CSV | Customer Name, Mobile No., Alternate Mobile, Email ID, Lead Source, Looking For, Property Type, BHK, Budget Min, Budget Max, City, Preferred Location, Purpose, Timeline, Temperature, Language, Contact Method, Remarks, Lead ID, Assigned To, Site Visit Date, and a second **City** | 17 mapped |
| XLSX | Client Name, Contact Number, Phone 2, E-mail, Source, Requirement Type, Unit Type, Min BHK, Budget From, Budget To, Preferred City, Area, Purpose, Time Frame, Intent, Preferred Language, Preferred Contact Method, Enquiry Details, Lead ID, Assigned To, Site Visit Date | 18 mapped |

`Lead ID`, `Assigned To` and `Site Visit Date` are unsupported and must stay unmapped. A file column can never set the lead owner. In the CSV, the duplicated `City` heading is ambiguous: neither copy is suggested, and the CSV raises a `HEADER_DUPLICATE` warning.

**Cases (29 per file):**
- **11 valid:**
  - phone formats: `+91` with spaces, trunk `0`, plain 10 digits, `91-` with hyphens, parentheses, `0091`, dotted (CSV) or a number cell (XLSX);
  - budget formats: `85 L`, `1.2 Cr`, `85,00,000/-`, `₹ 75 Lakh`, `Rs. 1.5 crore`, `8,500,000`, `50k`, `95 Lac` or a number cell;
  - vocabulary spellings: Purchase/Rent/Lease commercial, Flat/Bungalow/Office space, `2 BHK`, Hot/warm, Within 1 month / 3-6 months, Investment, Hindi/English, WhatsApp/Call;
  - a row with only the required fields;
  - a note with a comma, quotes and a line break;
  - **2 existing-lead matches**, one by primary phone and one by alternate phone.
- **15 invalid**, each with its fixed code:
  - missing name; missing phone;
  - phone `PHONE_INVALID_LENGTH`, `PHONE_NOT_INDIAN`, `PHONE_INVALID_CHARACTERS` (Excel scientific notation saved as text), `PHONE_NOT_MOBILE`;
  - budget range, budget with words, `2 million` (unknown unit), minimum above maximum;
  - bad email; property type outside the vocabulary; alternate phone equal to primary; unknown source name;
  - a row with two problems, where both are reported.
- **2 in-file duplicates:** the same phone written differently, and an exact copy.
- **1 empty row** in the middle of the data.

**Results:**

| Test | Result |
|---|---|
| `src/modules/imports/pilot-fixture.test.ts` (new, no database), both files | **12/12 PASS**: file checks and parse, with exact headers and row counts; XLSX reads `Read me` by default (no suggestions) and `Leads` when chosen; exact suggested mapping, with unsupported and ambiguous columns unmapped and no fatal header issue; **every row's outcome and codes as expected**; exact E.164 phones and INR amounts; vocabulary values; source by name and the default for a blank cell; counts **29 total = 11 valid + 15 invalid + 2 in-file duplicates + 1 empty** |
| `tests/integration/import-pilot-fixture.test.ts` (new, local `crm_test`), both files | **2/2 PASS**: real job flow (upload verification → analyse → choose `Leads` → mapping → validate → confirm → import).<br>• Counts as above; `existingDuplicates = 2`.<br>• Row results exactly match the fixture's expectations, including both `DUPLICATE_ATTACHED` matches with the right lead ids.<br>• After the import: **9 created + 2 attached**, 0 skipped, 0 failed; existing leads received the enquiry and kept their own data.<br>• A created lead has the normalised fields (BUY, APARTMENT, 2 BHK, `hi`, localities, ₹85,00,000–₹1,20,00,000).<br>• **No fixture cell value** (names, phones, emails, notes, budgets, IDs, rejected values) appears in the issue list or the problems CSV |
| Files on disk | Both pass `inspectFileBytes` and parse (the CSV is byte-identical to the in-memory fixture); both are git-ignored |
| Unit tests for the imports module (all) | 50/50 |
| `pnpm typecheck`, ESLint (`src tests scripts`) | Clean |

**Defect found and fixed.** The **Source** column's hint said an unknown source name falls back to the default source. Validation, intentionally and already under test, reports it as `SOURCE_UNKNOWN`.
- **Fix:** the hint text in `mapping.ts` and the mapping screen's default-source hint now state the real rule. The rule itself was **not** loosened.
- **Regression test:** in `pilot-fixture.test.ts`.
- **Practical consequence for real files:** a portal export whose Source column holds names like "99acres" makes those rows invalid, unless lead sources with exactly those names exist, or the Source column is left unmapped. Lead-source management UI is still deferred from M1, so for now sources must exist before import.

**No other compatibility issue was found in the synthetic scenarios.**

**Limitations.** Real headers, real spelling variants, real Excel quirks (merged cells, header not on row 1, hidden sheets, dates, localised number formats), real value distributions and real duplicate patterns remain **unverified** until a brokerage export (P6) is validated.

### Real-browser acceptance (runbook §4 step 3), 2026-10-24: PASSED

Real Chrome (via the Claude-in-Chrome extension), the production standalone build on `http://localhost:3200` and **one** worker (a `tsx` launcher PID with one child; no duplicate or orphaned workers), both on local `crm_dev`, storage = the real `crm-imports` bucket.
- Port 3000 was occupied by an unrelated local project (`affex-v2` frontend), which was left untouched; the CRM ran on 3200 with `BETTER_AUTH_URL` to match.
- Sign-in: the synthetic `AcceptA` Owner, with password and TOTP on the real login and two-step screens.
- Files: the existing synthetic files from `scripts/storage-check/synthetic-files.ts`.
- The 20 MB app and bucket limits were unchanged.

| Check | Result |
|---|---|
| Served CSP | `connect-src 'self' https://<ref>.supabase.co` |
| **Before upload: what the browser holds** (HTML, all 11 loaded scripts (~667k characters), localStorage/sessionStorage, JS-visible cookies) | No `sb_secret_`, `service_role`, `SUPABASE_SERVICE`, `SUPABASE_URL`, `@supabase`, `storage-js`, `supabase-js`, `createSignedUploadUrl`, `read-excel-file` or `csv-parse`. The CRM session cookie is HttpOnly (not visible to JS). The only JS-visible cookie, `_awa_aid`, belongs to the other app on `localhost:3000` (browsers share cookies across ports of the same host) |
| **CSV upload** (`synthetic-leads.csv`, 164 B) | **Progress screen:** bar at 100 %, button locked ("Working…"), job listed as "Waiting for upload"; no success shown before the server confirmed.<br>**Browser request** (Resource Timing): XHR to `https://<ref>.supabase.co/storage/v1/object/upload/sign/crm-imports/orgs/<org>/imports/<job>/<random>.csv` → **200**.<br>**Flow:** "Map columns" (4 rows, Name/Mobile suggested) → **Check rows** → "Ready to import": 2 valid, 1 with problems, 1 earlier duplicate, "Nothing has been written to your leads yet" → attestation + **Import 2 rows** → **"Completed with problems", 2 new leads**. Problems listed by row, column and message; the bad value is not shown |
| **XLSX upload** (`synthetic-leads.xlsx`, 2,270 B; sheets "Read me", "Leads") | **Progress screen:** "Uploaded – Working… this page updates by itself".<br>**Browser request:** XHR to `…/upload/sign/crm-imports/orgs/<org>/imports/<job>/<random>.xlsx` → **200**.<br>**Flow:** the first sheet was read by default → chose **Leads** → **Read this sheet** → 4 rows, Name/Mobile mapped → same validation → import → **"Completed with problems", 2 new leads** |
| Console during the uploads | No CSP, CORS, "Refused" or "blocked" messages |
| **After upload: re-scan** of the results page (HTML, 11 scripts (~558k characters), the problems CSV) | No key, env name, storage or parser library. The problems CSV has no synthetic names and no bad value |
| **Server side**, for the two browser uploads | **10/10 PASS**: job in org A, uploaded by the A Owner; key `orgs/<A>/imports/<job>/…`; `COMPLETED_WITH_ERRORS` with 2 created each; **bucket object SHA-256 = local file = the worker's recorded hash**; announced size = stored size = file size |
| Worker log | 0 errors. Steps: CSV needs_mapping → ready → completed; XLSX needs_mapping → needs_mapping (sheet re-read) → ready → completed |

**Limits of this step:**
- The "Importing" progress bar was not captured: 2-row imports finish between page refreshes. Its rendering is covered by the server-rendered page (and the e2e run), not by this browser session.
- The extension's network panel did not record the cross-origin XHR. The request was evidenced through the browser's Resource Timing API (URL, initiator, status), the absence of console errors, the server's verification and the stored bytes.
- Request headers were not visible. The browser cannot send the key, because it never receives it (scans above), and the client code sends only the grant's `content-type` and `x-upsert` headers.

**Processes.** The server, the worker and the browser tab were all stopped or closed afterwards (0 CRM node processes left; port 3200 free).

**Left behind:**
- in the real bucket: the two browser-uploaded objects, removed by a worker sweep after their purge time (about 23.9 h after finishing, around 2026-10-25 07:38 UTC), plus the two from the HTTP run (around 07:26 UTC);
- in local `crm_dev`: the synthetic data (4 more leads).

### Real Supabase Storage acceptance (runbook §4), resumed 2026-10-24

All results in this section are against the **real** Supabase bucket `crm-imports`. The local fake Storage API played no part, and none of its results are counted here.

**Setup.** The production standalone build (rebuilt with `SUPABASE_URL` set) and the worker run against local `crm_dev`. The CSP header served is `connect-src 'self' https://<ref>.supabase.co`, and `/.env` over HTTP returns 404.
- **Accounts:** two synthetic orgs (`AcceptA`, `AcceptB`) seeded in `crm_dev` with the test factory (`@example.test` addresses). Their authenticator secrets are kept in the session scratchpad only.
- **Worker environment:** `tsx --env-file=.env`. The worker does not read `.env` itself; in production its environment comes from the runtime.

| Step | Result (real bucket) |
|---|---|
| **1b. Bucket limits** (re-run with the API) | **PASS, 3/3:** disallowed type refused (415); 20 MB + 1 byte **refused by the bucket (413)**; exactly 20 MB accepted. All test objects removed (0 left) |
| **1. `verify-bucket.ts`** (2026-10-23, unchanged since) | **PASS, 18/18** |
| **2–5 over HTTP** (scripted with the e2e HTTP client: real sign-in with TOTP, Server Actions and page requests to the built server; uploads are real signed PUTs from Node) | **PASS, 55/55**, plus the cleanup check **8/8** |

The 55 + 8 checks:
- **CSV** (`synthetic-leads.csv`) and **XLSX** (`synthetic-leads.xlsx`, sheets "Read me" + "Leads", "Leads" chosen):
  - the grant names the job's own object in the org and points at the real project;
  - signed PUT without the key → 200; replayed PUT → 400 (no overwrite);
  - the server verified size and type; the worker analysed the file;
  - **the stored bytes are SHA-256-identical to the file, and the worker recorded the same hash**;
  - mapping and validation: 2 valid, 1 invalid, 1 in-file duplicate;
  - the import page shows no cell values and no key;
  - attested import → `COMPLETED_WITH_ERRORS` with 2 leads created as the uploader;
  - the problems CSV has rows and codes, no cell values.
- 4 new leads in total, all `created_by` the uploader.
- **Overwrite:** the CSV's grant used on the XLSX object → 400; the XLSX object unchanged.
- **Refusals:**
  - anonymous action → `UNAUTHENTICATED`; anonymous page → sign-in redirect;
  - Sales Executive: start → `FORBIDDEN`, page 404;
  - other org's Owner: page 404, problems CSV 404, cancel → `NOT_FOUND`.
- No service key or `sb_secret_` in any action response or page.
- **Cleanup:**
  - a control object outside `orgs/` (`manual-control/keep-<stamp>.csv`) was placed beforehand;
  - one import was cancelled at "Map columns" and one dry run completed (0 leads written);
  - the **real worker's sweep** logged `due 2, deleted 2, refused 0, errors 0`;
  - both objects are gone from the bucket, with `file_deleted_at` recorded;
  - the two completed imports keep their files, with purge scheduled 23.9 h after finishing;
  - **the control object survived the sweep** (the test then removed it).

**§4 step 3 in a real browser:** passed later the same day; see "Real-browser acceptance" above.

The HTTP run covers the same server, storage and permission behaviour, but it is not a browser.

**Leftovers.** The two completed synthetic imports' objects stay in the bucket until a worker sweep after their purge time (about 23.9 h after finishing, 2026-10-25 around 07:26 UTC). The synthetic orgs, users and 4 leads remain in local `crm_dev`.

**Configuration note.** The secret key had been saved in `.env` as `SUPABASE_SECRET_KEY`. Only the variable name was changed to `SUPABASE_SERVICE_ROLE_KEY`; the value was untouched and never printed.

### Earlier attempt (2026-10-23): stopped at step 1b


**Configuration.** The project, bucket `crm-imports` and keys are configured in local `.env`.
- The secret key had been saved as `SUPABASE_SECRET_KEY`. With the owner's request in place, only the variable **name** was renamed to `SUPABASE_SERVICE_ROLE_KEY`, which the app and runbook use. The value was untouched and never printed. It is an `sb_secret_` key (41 characters).
- `SUPABASE_URL` has the `https://<ref>.supabase.co` form, and the full server environment schema validates.

**Rebuild.** `pnpm build` with `SUPABASE_URL` set: the CSP `connect-src` contains the project storage origin. The client bundles (`.next/static`) contain no `sb_secret_`, no storage SDK and no key value.
- The key value appears in exactly one build file, `.next/standalone/.env`. Next.js copies `.env` there for the local standalone server; it is not a browser asset.
- Production images exclude it: `.dockerignore` excludes `.env*`, and the Dockerfile fails the build if any `.env` file is in the standalone output.

| Step | Result (against the **real** bucket) |
|---|---|
| **1. `verify-bucket.ts`** | **18/18 PASS.**<br>• one-object grant, no key in it;<br>• browser-style PUT (no key) → 200;<br>• replay → 400 (no overwrite); the token for another object → 400;<br>• size 39, type `text/csv` and SHA-256 match;<br>• public, authenticated-without-key and direct anonymous reads → 400;<br>• delete idempotent; the control object survived; nothing left behind |
| **1b. Bucket limits** (checked through the API with the secret key; probe org only; objects removed afterwards, 0 left over) | **Disallowed type** (`application/x-msdownload`): refused, HTTP 415. **PASS.**<br>**Over 20 MB** (20 MB + 1 byte): **ACCEPTED. FAIL.** The bucket's file-size restriction is off or above the 20 MB that runbook §2 requires |
| 2–5. Synthetic files, browser flow (CSV and XLSX), refusals, cleanup | **Not run**: stopped at the first failure, as instructed |

**Why 1b matters.** A signed upload token does not fix the upload's size. The app refuses any size mismatch when the upload is confirmed (and the sweep deletes the object), and the worker never reads more than the announced size. Until then, though, only the bucket limit caps what a holder of a token can store. No app control was weakened, and none needs to change.

**Owner action:** in the Supabase dashboard, open Storage → `crm-imports` → Edit bucket and set "Restrict file upload size" **On, 20 MB** (equal to `IMPORT_MAX_BYTES`). Then re-run from step 1b.

### Earlier: real-storage check prepared, not run

**Acceptance attempt 2026-10-23: blocked at step 1 (configuration).** The owner reported the project and bucket as configured, but `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` were found in none of the places the app reads:
- `.env`: no line for either variable;
- no `.env.local`; `.env.s1-managed` has neither;
- not set in the shell or the Windows user/machine environment.

Nothing was rebuilt, no request was sent to Supabase, and no real-bucket check has run. The local fake results below remain the only storage-protocol evidence.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are empty in `.env`, so no Supabase project or private bucket is configured. Per the owner's instruction, nothing was created in or sent to the cloud. Prepared instead:

| Item | Status |
|---|---|
| `docs/runbooks/supabase-storage-setup.md` §4 rewritten as the exact procedure | Prerequisites (including the build with `SUPABASE_URL` for the CSP), then:<br>• step 1: bucket probe script; step 1b: bucket limits in the dashboard;<br>• step 2: synthetic files;<br>• step 3: browser flow for CSV and XLSX, with checks for key exposure;<br>• step 4: anonymous, Sales Executive and other-org refusals, token replay;<br>• step 5: cleanup, with a control object that must survive |
| `scripts/storage-check/verify-bucket.ts` (new) | 18 checks: one-object grant without the key; browser-style PUT; replay cannot overwrite; the token cannot write another object; size, type and SHA-256 after upload; three anonymous read paths refused; idempotent delete; an unrelated control object survives; nothing left behind. Uses only a probe org id no real org can have. **Validated against the local fake Storage API: 18/18 PASS.** With the real configuration absent it prints "Nothing done" and exits 2. **Never run against Supabase** |
| `scripts/storage-check/synthetic-files.ts` (new) | Writes `synthetic-leads.csv` and `synthetic-leads.xlsx` (made-up rows, one bad phone, one in-file duplicate, two sheets). Both pass `inspectFileBytes` and `parseImportFile` locally |
| `tests/e2e/fake-storage.ts` | Gained the server-side upload route (`POST /object/{bucket}/{key}`, no overwrite) that the probe's control object needs. The app's flow does not use it, so the e2e suites were not re-run for this additive change |

### Evidence levels (what was real, what was a double)

| Claim | Evidence |
|---|---|
| Database security of 0005 (RLS, grants, trigger, `crm_cleanup`) | **Real PostgreSQL**: tests on `crm_test`; catalog, schema-equality and live probes on `crm_dev` |
| Import flow logic (jobs, worker, batches, pause/resume, cancel, cleanup sweep, isolation) | **Real PostgreSQL** (`crm_test`), with an **in-memory storage double** |
| HTTP flow (server actions, pages, CSV route, worker via outbox and BullMQ) | **Real built server and worker** (`crm_test`), with a **local fake of the Supabase Storage REST API**, and without a real browser |
| Supabase signed upload, CORS and CSP in a real browser, bucket privacy and limits, real deletion | **Verified against the real bucket on 2026-10-24**: probe 18/18, limits 3/3, HTTP flow 55/55, cleanup 8/8, real-browser CSV and XLSX flow with server-side integrity 10/10 |
| Real-world file formats (portal exports) | **Not yet verified** (P6 pilot files) |

## Part 3: the complete import flow

**Database.** Migration `0005_imports` is applied to the local **`crm_test` only**. `crm_dev` is untouched: it still records only 0001–0002, and `crm_cleanup` cannot connect to it. No Neon or Supabase resource was used.

**What exists:**

| Area | Implementation | Where |
|---|---|---|
| Job service (web) | **Who can do what:**<br>• **Start, verify upload, choose sheet, map, confirm, resume:** the uploader only, because the worker writes leads as them.<br>• **Cancel:** any Owner or Admin.<br>• **Re-checked on every call:** `lead.import` + `lead.create`, a member context, and RLS through `withTenant()`.<br>**Double submissions:** status changes are compare-and-set on status and version, so a double click or replay changes nothing. This is enforced in SQL by the 0005 trigger and checks.<br>**Abuse limit:** at most 5 uploads in flight per user.<br>**Audit:** `import.created / confirmed / resumed / cancelled` | `src/modules/imports/jobs.ts` |
| Upload | **Grant:** the server creates the job and a signed upload permission for ONE server-built key (`orgs/<org>/imports/<job>/<random>.<ext>`). The browser PUTs to it directly; the service key never leaves the server.<br>**Confirm (`confirmUpload`):** the object must exist with exactly the announced size and the granted content type. Otherwise the job fails and the next sweep deletes the file. A missing object leaves the job open for a retry.<br>**Integrity:** the worker re-checks the size on download and records the SHA-256 at analysis. Validation and import refuse the file if the hash changes (`FILE_CHANGED`) | `jobs.ts`, `processor.ts`, `upload-form.tsx` |
| Worker | `import.process_requested` outbox event → dedicated `imports` BullMQ queue (concurrency 2) → `processImportJob`. It reads the job state, so a duplicate or stale message is a no-op. Steps:<br>• **analyse:** download, size, hash, `inspectFileBytes`, parse, header checks, mapping suggestions, same-file warning;<br>• **validate:** every row through `validateRow`/`prepareLead`, in-file duplicates, read-only existing-lead matches; row results and counts only;<br>• **import:** batches of 200.<br>Parsing happens only here; the parser modules are not exported to web code (ESLint `WORKER_ONLY`), and the built `.next` server and client output contain neither reader | `src/modules/imports/processor.ts`, `src/worker/main.ts`, `src/worker/handlers.ts` |
| Atomic batches | Each batch runs in one transaction as the uploader:<br>• `SELECT … FOR UPDATE` on the job, checking status IMPORTING and that the cursor equals the expected start;<br>• `leads.commitImportBatch` (the existing duplicate lock, ATTACH/SKIP, assignment with a per-batch target re-check, notifications);<br>• row results, counters and the new cursor.<br>A crash rolls the batch back and the retry resumes from the cursor. `external_id` idempotency remains as a second guard | `processor.ts`, `src/modules/leads/importing.ts` |
| Uploader identity | `memberContext()` rebuilds the uploader's context from `app.auth_memberships_for_user` (shared with the web; extracted from `context.ts`).<br>It is checked before analysis, before validation and **before every batch**. If it is lost mid-import, the job becomes `PAUSED` (`UPLOADER_NOT_AUTHORIZED`, system audit `import.paused`) and nothing more is written.<br>Only the uploader can resume, with a valid session; the worker checks again on the next batch. Another Owner or Admin can cancel | `src/platform/auth/member-context.ts`, `processor.ts` |
| Dry run | A dry run validates and writes row results and counts, then goes `READY → COMPLETED`. It never calls the lead write path. The 0005 CHECKs (`import_job_attested`, `import_job_dry_run_writes_nothing`) and the trigger make IMPORTING impossible for a dry run | `processor.ts` |
| Cancel | Direct for every unfinished state. A running batch holds the job row lock, so a cancel lands after it commits; nothing later is written. Leads already imported are kept | `jobs.ts` |
| Retry | Transient storage errors are rethrown, so BullMQ retries (5 attempts, exponential). A crashed step resumes from database state | `processor.ts`, `src/platform/queue` |
| Cleanup sweep | Every 10 minutes, the worker lists due files over `CLEANUP_DATABASE_URL` (`crm_cleanup`, `app.import_files_due` only).<br>`sweepImportFiles` then:<br>• refuses any entry whose key fails `keyBelongsTo`, or does not equal the job row's key (read in that org's tenant transaction);<br>• deletes the object (idempotent);<br>• ends unfinished jobs (waiting → EXPIRED, mid-step → FAILED with `FILE_EXPIRED`);<br>• sets `file_deleted_at` once.<br>Repeating a sweep is a no-op. Retention: abandoned uploads and waiting steps after 3 h; finished jobs ≤ 24 h (dry runs and failures immediately); paused jobs about 24 h | `src/modules/imports/cleanup.ts`, `src/worker/main.ts` |
| UI | **`/app/leads/import`:** upload with progress (shown as uploaded only after the server's check), recent imports.<br>**`/app/leads/import/[id]`:**<br>• status read from the job row, so it survives a refresh, with auto-refresh while the worker works;<br>• sheet picker; column mapping with suggestions; default source; duplicate policy; assignment (unassigned, person, team queue, in turn); dry-run option;<br>• validation summary; attestation (FR-170) and the same-file acknowledgement; progress bar;<br>• resume and cancel, with locked buttons;<br>• row problems as row, column heading and a fixed message;<br>• `issues.csv` download (formula-leading cells neutralised).<br>Never cell values, secrets or stack traces | `src/app/(app)/app/leads/import/**` |
| Messages | A fixed text for every job error and row code | `src/modules/imports/messages.ts` |

**Defects found and fixed in my own code during testing (no 0005 change was needed):**
- **Retention cap:** the worker set a finished job's file retention to exactly "now + 24 h" from the app clock. `bounded_retention` measures from the transaction start, so the policy correctly refused it. It is now 23.9 h.
- **Outbox test:** `worker-outbox.test.ts` assumed one relay call drains the outbox. With the new import tests, more than one relay batch (100) can be pending in a combined run. The test now drains first; its assertions are unchanged.

**Preview.** Cell values are never stored outside the file, and parsing never runs in the web server. So the mapping step shows column headings with suggestions, and the "preview" is the full validation pass: counts, every row problem and every existing-lead match, before anything is written. A preview of sample cell values is deliberately not shown.


## Part 1: groundwork (before the approvals)

| Area | What exists | Where |
|---|---|---|
| Storage gateway | Typed, server-only `ObjectStorage`: signed single-object upload grant (no overwrite), stat, size-capped download, idempotent remove, controlled server upload. Supabase adapter with 15 s timeouts, 3 attempts on transient errors only, and errors reduced to fixed codes (no provider text, URL, token or key) | `src/platform/storage/` |
| Object keys | `orgs/<org>/imports/<record>/<128-bit random>.csv\|xlsx`, built only from server ids, never the filename. `keyBelongsTo()` for cleanup | `src/platform/storage/keys.ts` |
| Configuration | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_IMPORT_BUCKET`, `IMPORT_MAX_BYTES` (default 20 MB, max 50 MB), all validated. Optional (blank = off). The URL and key must be set together; https only (except localhost); the publishable key is refused | `src/env.ts`, `.env.example` (placeholders only) |
| Secret boundaries | ESLint: only `src/platform/storage` may import `@supabase/*`. A unit test: no client component imports the storage gateway, the env or the SDK, and no `NEXT_PUBLIC_` variable names a key. CSP `connect-src` gains only the storage **origin**, and only when it is configured | `eslint.config.mjs`, `client-boundary.test.ts`, `next.config.ts` |
| Permission | `lead.import`: Owner/Admin (org scope). Manager stays off until the "cfg" org setting exists. Executives, HR and support: none | `src/platform/authz/permissions.ts` |
| File checks | Before upload: name, extension (`.xlsm/.xls/.xlsb` refused), size and the declared type. After upload, before parsing:<br>• signatures;<br>• CSV must be UTF-8 with no NULs;<br>• XLSX structure via a bounds-checked ZIP reader: no VBA or ActiveX, no encryption, ≤ 20 sheets, ≤ 2,000 entries;<br>• zip-bomb limits on compression ratio and total size, with every entry actually inflated under a hard cap, so lying headers are caught | `src/modules/imports/file-check.ts`, `zip.ts` |
| Mapping | Catalogue of importable fields, built from the existing manual-create fields plus a source matched by name. Header auto-suggest. Header checks (missing, empty, duplicate, too long, too many). Validation of untrusted mappings (unknown fields such as `orgId`/`ownerUserId` refused; columns in range; one field per column; required fields mapped) | `src/modules/imports/mapping.ts` |
| Row validation | Each row becomes the manual-create input and goes through the **same** `prepareLead` rules: M0 phone/budget normalisation, enums with common portal spellings, BHK, localities, alternate ≠ primary. Results hold the row number, field and code only (never values). Empty rows are skipped. In-file duplicates are handled keep-first (FR-044) | `src/modules/imports/rows.ts`, `src/modules/leads/input.ts` |
| Lead write path | `importLeadBatch` is the only way import rows become leads:<br>• one transaction per batch (≤ 500 rows); all of the batch's phones are locked in sorted order;<br>• an open duplicate is **attached** as an enquiry with the owner notified, or **skipped**, by policy; existing lead data is never overwritten;<br>• new leads go through `insertNewLead`, the same code manual create now uses;<br>• assignment at import uses M3 target checks and the locked round-robin pointer (source `IMPORT`), with a digest per assignee;<br>• **retry-safe**: each enquiry carries `external_id = "<importId>:<row>"` (existing unique index), so a re-run reports `ALREADY_IMPORTED` and writes nothing | `src/modules/leads/importing.ts`, `write.ts`, `assignment.ts` |
| UI groundwork | "Import" button on `/app/leads` (Owner/Admin). `/app/leads/import` shows the file rules and mappable columns with a clear "not available yet" notice. There is no upload control and no simulated result | `src/app/(app)/app/leads/import/page.tsx` |
| Docs | Supabase bucket runbook; approval proposal (parser comparison, exact SQL, RLS, grants, worker access, rollback) | `docs/runbooks/supabase-storage-setup.md`, `docs/PHASE-2-M4-PROPOSAL.md` |

**Refactors with no behaviour change:**
- Lead input schemas and normalisation moved to `leads/input.ts`, which now gives each field error a machine code.
- New-lead inserts and notes moved to `leads/write.ts`.
- `findOpenMatch` was extracted.
- Round-robin pointer handling was extracted (`roundRobinDealer`).

The existing lead, list and assignment integration suites pass unchanged.

## Part 2 (after approval)

| Area | What exists | Where |
|---|---|---|
| Parsers | `read-excel-file@9.3.12` and `csv-parse@7.0.3`, exact pins. The lockfile passes the supply-chain policy, and `pnpm audit --prod --audit-level high` reports no known vulnerabilities. ESLint lets only `parse.ts` import them | `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs` |
| Parsing | `parseImportFile` runs in the worker only, after `inspectFileBytes`.<br>**XLSX:**<br>• sheet names are read from `xl/workbook.xml` through our own bounds-checked zip reader, then the chosen sheet is read (OD-08);<br>• numbers stay as their saved text, so phone numbers keep every digit;<br>• dates come back as dates;<br>• formulas are never evaluated: the cached value is used, or the cell is empty.<br>**CSV:** handles a BOM, quoted commas and newlines, and ragged rows. The delimiter (`,` `;` or tab) is detected from the header line, and records are capped at 64 KB.<br>**Rows:** the header is the first non-empty row within the first 20 rows; row numbers match the spreadsheet; trailing blank rows are dropped.<br>**Limits:** 100,000 data rows and the 120 s budget, on top of every existing size, zip and decompression limit.<br>**Failures:** fixed codes (`PARSE_FAILED`, `PARSE_TIMEOUT`, `SHEET_NOT_FOUND`, `HEADER_MISSING`, `TOO_MANY_ROWS`). Reader messages, which can quote sheet names, are never shown or logged | `src/modules/imports/parse.ts` |
| Test files | Synthetic XLSX/zip builder shared by the file-check and parser tests | `tests/support/spreadsheets.ts` |
| Migration | `0005_imports` is written: a generated part plus a hand-written security part. **Not applied.** The Prisma client was regenerated locally only | `prisma/migrations/0005_imports/migration.sql`, `prisma/schema.prisma`, `prisma/README.md` |
| Import page | The notice now names only the outstanding step (the import-job tables) | `src/app/(app)/app/leads/import/page.tsx` |

**Spike result (§A approval), on synthetic files:**
- saved values are returned rather than formulas, and a formula without a cached value reads as empty;
- dates come back as dates;
- sheets can be listed and chosen;
- 100,000 rows × 3 columns parse in about 0.8 s. A 12-column spike took about 2 s with an 88 MB heap.

## 0005 security review

**Changes from the approved B.2 design.** Each one either tightens the design or fixes a defect.

1. **New `PAUSED` status.** As the approval asks, if the uploader loses authorisation, the worker pauses instead of continuing as a system actor.
   - Transitions: `IMPORTING ↔ PAUSED`, and `PAUSED → EXPIRED / FAILED / CANCELLED`.
   - A paused job keeps the org's single running slot (`import_job_one_running_uq` covers `IMPORTING` and `PAUSED`), so it can never interleave with a newer import.
2. **Dry-run defect fixed.** B.2 allowed `READY → COMPLETED` for a dry run, but its own CHECK required `attested_at` and `NOT dry_run` for `COMPLETED`, so a dry run could never finish. Now:
   - `IMPORTING` and `PAUSED` require an attested, non-dry-run job;
   - `COMPLETED*` requires a dry run or an attestation;
   - a dry run must have `rows_created = rows_attached = next_row = 0`;
   - the trigger allows `READY → COMPLETED` only when `dry_run` is set.
3. **Trigger hardened.**
   - Finished jobs are fully frozen: every column except `file_deleted_at`, `updated_at` and `version`. B.2 froze only `status`.
   - The mapping, sheet, source, duplicate policy, assignment, attestation and hash are fixed while a job is `IMPORTING` or `PAUSED`.
   - `next_row` never moves back.
   - Two transitions were added: `NEEDS_MAPPING → ANALYSING` (choose another sheet) and `READY → NEEDS_MAPPING` (edit the mapping).
4. **The database owns the deadlines.**
   - `upload_expires_at` and `purge_file_after` have database defaults (+2 h and +3 h).
   - The INSERT policy refuses later values. It also requires `attested_at IS NULL` and `next_row = 0`.
   - A new RESTRICTIVE policy, `bounded_retention` (UPDATE), refuses a `purge_file_after` more than 24 h ahead, so no session can keep a file indefinitely.
5. **`job_is_active`** also requires the result's `attempt` to equal the job's current `validation_attempt`.
6. **The definer function** uses `search_path = pg_catalog, pg_temp`, as in 0002 (B.2 had `public`), and schema-qualifies the table.
7. **More CHECKs:**
   - `next_row ≤ rows_total`;
   - the length of `sheet_name`;
   - the format of `attestation_version`;
   - the range of `related_row`.
   `sheet_names` and `headers` are NOT NULL, because Prisma generates nullable arrays.

**Review by area:**

| Area | Review |
|---|---|
| RLS | Both tables have RLS ENABLE + FORCE, with `maintenance` (crm_migrator) and `tenant_isolation` (crm_app) in the same text as 0002–0004.<br>Three RESTRICTIVE policies only narrow access:<br>• `actor_is_session_user` (INSERT);<br>• `bounded_retention` (UPDATE);<br>• `job_is_active` (INSERT on results).<br>Every foreign key is composite `(org_id, …)`, and the `storage_key` CHECK binds the object path to the row's own org and id. No existing policy is touched.<br>As with every tenant table, any org member's crm_app session could read job rows at the database level. `lead.import` (Owner/Admin) is enforced in the module. The rows hold file names, header names, codes and counts, never cell values |
| Grants | **crm_app:** SELECT and INSERT on both tables, and UPDATE on the listed `import_job` columns only. It can never update `id`, `org_id`, `created_by`, `storage_key`, the file type, size or name, `created_at` or `upload_expires_at`. No DELETE.<br>**crm_definer:** SELECT on 5 columns, used only inside `app.import_files_due`.<br>**crm_cleanup** (new, provisioned separately): `USAGE` on schema `app` and `EXECUTE` on `app.import_files_due` only.<br>**crm_auth, crm_platform:** nothing.<br>No existing role is altered |
| Status transitions | Enforced by `import_job_guard` (BEFORE UPDATE), the first trigger in the schema. FAILED and CANCELLED are reachable from any unfinished state; every other transition is allow-listed. The integrity rules are CHECKs, so they hold for every role, including the migrator |
| Cleanup | `app.import_files_due(n)` is SECURITY DEFINER, owned by the NOLOGIN role `crm_definer`, with EXECUTE for `crm_cleanup` only (see the cleanup-role correction). It returns at most 500 `(org_id, job_id, storage_key)` rows whose `purge_file_after` has passed.<br>The worker sweep (`src/modules/imports/cleanup.ts`, built in part 3):<br>• delete an object only if `keyBelongsTo(key, orgId, 'imports', jobId)` holds;<br>• set `file_deleted_at` inside that org's tenant transaction;<br>• move an unfinished job to EXPIRED (waiting states) or to FAILED with `FILE_EXPIRED` (in-flight states).<br>While working, the worker pushes `purge_file_after` forward (by at most 3 h) before each step, so a live import keeps its file and a stalled one loses it. Job and result rows are kept, because there is no DELETE grant |
| Worker identity (planned) | Each batch runs in `withTenant({ orgId, userId: uploader })` as crm_app. The existing lead policies (`created_by = app.user_id`) therefore attribute every lead, enquiry, history and activity row to the uploader.<br>Before every batch, the worker rebuilds the uploader's context through `app.auth_memberships_for_user`, the same check the web uses. All of these must hold:<br>• the membership is ACTIVE;<br>• the org is ACTIVE;<br>• the role is Owner or Admin;<br>• `lead.import` and `lead.create` are granted.<br>If any check fails, the job moves to `PAUSED` with `error_code = 'UPLOADER_NOT_AUTHORIZED'` and nothing more is written. There is no system-actor fallback.<br>Each batch's leads and its cursor and counter update share one transaction, so a crash, pause or cancel never half-commits a batch. The existing `external_id` idempotency still covers retries |
| Not yet verified | **The SQL has not been executed anywhere**: applying it was deferred to this review. The first local apply, to `crm_test`, will also run `db-roles.test.ts`, whose catalog checks cover new tables automatically |

## Cleanup-role correction (before applying 0005)

**Owner finding:** in the first draft, `EXECUTE` on `app.import_files_due` went to the shared `crm_app` role. Any web request could therefore list every org's import job ids and storage keys.

**Fix:** a dedicated database role, `crm_cleanup`, used only by the worker's cleanup sweep over its own connection.

| Piece | Change |
|---|---|
| Role | `crm_cleanup`: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, NOREPLICATION, **NOINHERIT**, CONNECTION LIMIT 2; `statement_timeout` 10 s. It is a member of no role, and no role is granted to it. It gets CONNECT on the database and nothing else. It is created by role provisioning, not by the migration, because `crm_migrator` cannot create roles. 0005 fails if the role is missing |
| Migration 0005 | `REVOKE ALL … FROM PUBLIC` and `FROM crm_app, crm_auth, crm_platform`; `GRANT USAGE ON SCHEMA app` and `GRANT EXECUTE` on the function to `crm_cleanup` only. The function itself is unchanged: SECURITY DEFINER owned by `crm_definer`, `search_path = pg_catalog, pg_temp`, `public.import_job` qualified, 3 columns, `LIMIT least(greatest(p_limit, 0), 500)` |
| Provisioning | New idempotent `scripts/db/provision-cleanup-role.sql`, run per database as a role admin (`postgres` locally, the provider admin on managed hosting). It re-asserts the attributes on every run and prints a verification row. `docker/postgres/init/01-roles.sh` runs the same script on a fresh volume when `CRM_CLEANUP_PASSWORD` is set (`docker-compose.yml` passes it, optional, and mounts the script read-only). `scripts/db/bootstrap-managed-roles.sql` documents the follow-up step |
| Worker configuration | `CLEANUP_DATABASE_URL` (optional; must connect as `crm_cleanup`, validated in `src/env.ts`). Without it the sweep does not run. The gateway is `src/platform/db/cleanup.ts` (`importFilesDue`) on a separate one-connection pool (`cleanupPrisma()` in `client.ts`). ESLint keeps it out of modules and routes. `.env.example` has placeholders only (`CRM_CLEANUP_PASSWORD`, `CLEANUP_DATABASE_URL`, `TEST_CLEANUP_DATABASE_URL`) |
| No session flags | Access depends only on the database login identity. There is no GUC or application setting to spoof |

**Tests:**
- `src/platform/db/cleanup-grants.test.ts` (unit, run). Static checks over all migrations and the provisioning SQL:
  - the function shape;
  - `EXECUTE` revoked from PUBLIC and the shared roles;
  - `crm_cleanup` the only grantee;
  - `crm_cleanup`'s only migration grants are schema `app` usage and that one `EXECUTE`;
  - the role attributes;
  - no memberships.
  A mutation check (re-adding `GRANT EXECUTE … TO crm_app`) makes it fail.
- `src/env.test.ts` (+1, run): `CLEANUP_DATABASE_URL` is optional, and only `crm_cleanup` is accepted.
- `tests/integration/import-cleanup-role.test.ts` (run after the local apply: 19/19, see below):
  - `crm_cleanup` lists due files across orgs (3 columns; not-due and already-deleted files left out; the row cap holds; the worker gateway returns the same rows);
  - `crm_cleanup` has no elevated attributes, no inheritance, no memberships and owns nothing;
  - `crm_cleanup` gets 42501 on **every** public table, can execute exactly one `app` function, can create nothing, and cannot `SET ROLE` to any other CRM role;
  - the function's ACL is exactly `{crm_cleanup, crm_definer}`;
  - `crm_app`, `crm_auth` and `crm_platform` get 42501 calling it;
  - `crm_auth` and `crm_platform` cannot read `import_job`;
  - `crm_app` sees no jobs without a tenant, and only its own org's jobs with one;
  - `crm_app` cannot assume `crm_cleanup` or `crm_definer`;
  - no definer function `crm_app` may execute reads `import_job`.
- `tests/integration/db-roles.test.ts`: `crm_cleanup` added to the role list and to the hardening matrix (run after the local apply: 57/57).

**Before 0005 can be applied locally:**
1. Add `CRM_CLEANUP_PASSWORD` and `TEST_CLEANUP_DATABASE_URL` to `.env` (see `.env.example`). Integration tests now require the latter.
2. Run `scripts/db/provision-cleanup-role.sql` for `crm_test` and `crm_dev`.

## Local apply to crm_test (2026-10-23, owner-approved)

**Target check.** All test URLs resolve to `127.0.0.1:55432/crm_test` (the local Docker `cbr-crm-postgres-1`). Before the apply, `crm_test` held 0001–0004 and only leftover synthetic test data, which the integration setup truncates on every run. `crm_dev` was not touched: it still has 0001–0002 and no `crm_cleanup` CONNECT grant.

**Configuration.** `CRM_CLEANUP_PASSWORD` (random, generated locally) and `TEST_CLEANUP_DATABASE_URL` (`crm_cleanup@127.0.0.1:55432/crm_test`) were appended to `.env`. Neither value was printed.

**Password handling.** Provisioning now never sends the plaintext password:
- `scripts/db/provision-cleanup-role.mjs` computes a SCRAM-SHA-256 verifier locally and passes it to the SQL script on stdin.
- The SQL creates the role, or **aligns** an existing role's password to the verifier, and refuses anything that is not a verifier.
- The wrapper refuses to run if the password inside the URL differs from `CRM_CLEANUP_PASSWORD`. After provisioning, it proves the URL logs in as `crm_cleanup` to that database.

**Provisioning results:**

| Case | Result |
|---|---|
| URL password ≠ configured password | Refused before connecting (exit 1, clear message) |
| Plaintext instead of a verifier | Refused by the SQL (`ERROR: cleanup_verifier is not a SCRAM-SHA-256 verifier…`, psql exit 3); no role was created |
| First run | Role created; verification row `f\|f\|t\|f\|0`; URL login OK |
| Stale password (deliberately desynchronised) | Login refused with 28P01; re-run aligned it; login OK; stored as `SCRAM-SHA-256$…` |

**Migration.** `prisma migrate deploy` ran with the migrator URL asserted to be the local `crm_test`. Result: `0005_imports` applied, and `_prisma_migrations` shows 0001–0005 finished, none rolled back.
- `app.import_files_due(integer)`: owner `crm_definer`, SECURITY DEFINER, `search_path=pg_catalog, pg_temp`, ACL `{crm_definer=X, crm_cleanup=X}`.
- RLS is enabled and forced on both new tables.

**Database tests (crm_test):**

| File | Result |
|---|---|
| `import-cleanup-role.test.ts` (new) | 19/19 |
| `import-job-schema.test.ts` (new: creation policy, storage-key binding, tenant isolation, column grants, retention bound, state machine, one running import, dry run, row-result policy) | 23/23 |
| `db-roles.test.ts` (now includes `crm_cleanup`) | 57/57 |
| `cross-org-isolation.test.ts` | 16/16 |
| `import-commit.test.ts` | 9/9 |

The first run of the two new files failed in **setup** with `APIError: Invalid email`: the test org names contained spaces and were used to build e-mail addresses. Renaming the orgs fixed it; no security assertion failed.

**Manual probe:** `crm_cleanup` can call the function. It gets 42501 on `import_job` and `lead`, and on `SET ROLE` to `crm_definer` or `crm_app`. `crm_app` gets 42501 calling the function and on `SET ROLE crm_cleanup`.

**Other checks:**
- Unit tests 515/515;
- typecheck, ESLint (whole repository), Prettier;
- `pnpm build`, `pnpm build:worker`.

## Limits

These are in `src/modules/imports/limits.ts`; the byte limit comes from the environment.

| Limit | Value |
|---|---|
| File size | 20 MB (`IMPORT_MAX_BYTES`, capped at 50 MB) |
| Rows / columns / worksheets | 100,000 / 100 / 20 |
| Cell / header length | 5,000 / 200 characters |
| XLSX zip entries / uncompressed total / compression ratio | 2,000 / 256 MB / 200 : 1 |
| Parse time budget (worker) | 120 s |
| Preview rows / rows per transaction | 50 / 200 (code maximum 500) |

## Files

Part 3:
- **New:**
  - `src/modules/imports/{jobs,processor,cleanup,messages,actions}.ts`
  - `src/platform/auth/member-context.ts`
  - `src/app/(app)/app/leads/import/{upload-form.tsx,status.ts}`
  - `src/app/(app)/app/leads/import/[id]/{page.tsx,controls.tsx}`
  - `src/app/(app)/app/leads/import/[id]/issues.csv/route.ts`
  - `tests/support/memory-storage.ts`
  - `tests/integration/{import-flow,import-job-schema}.test.ts`
  - `tests/e2e/{import-flow.test.ts,fake-storage.ts}`
- **Changed:**
  - `src/modules/imports/{index,parse}.ts`
  - `src/modules/leads/{importing,index}.ts` (`commitImportBatch`, `openLeadsByPhone`, `checkImportAssignment`, `unknownSourceId`)
  - `src/platform/auth/context.ts` (uses `member-context.ts`; same behaviour)
  - `src/platform/outbox/index.ts`, `src/platform/queue/index.ts`
  - `src/worker/{main,handlers}.ts`
  - `src/app/(app)/app/leads/import/page.tsx`
  - `eslint.config.mjs`
  - `tests/e2e/{server,http,leads-routes.test}.ts`, `tests/integration/worker-outbox.test.ts`
  - provisioning: `scripts/db/provision-cleanup-role.{sql,mjs}`, `docker/postgres/init/01-roles.sh`
  - docs


Part 2:
- **New:**
  - `src/modules/imports/parse.ts` and its test `parse.test.ts`
  - `tests/support/spreadsheets.ts`
  - `prisma/migrations/0005_imports/migration.sql`
- **Changed:**
  - `package.json`, `pnpm-lock.yaml`, `eslint.config.mjs`
  - `prisma/schema.prisma`, `prisma/README.md`
  - `src/modules/imports/index.ts`
  - `src/modules/imports/file-check.test.ts` (now uses the shared zip builder)
  - `src/app/(app)/app/leads/import/page.tsx`
  - `docs/PHASE-2-PLAN.md`

Part 1:

- **New:**
  - `src/platform/storage/{index,types,keys,supabase}.ts` and the tests `storage.test.ts`, `client-boundary.test.ts`
  - `src/modules/imports/{index,limits,zip,file-check,mapping,rows}.ts` and the tests `file-check.test.ts`, `rows.test.ts`
  - `src/modules/leads/{input,write,importing}.ts`
  - `src/app/(app)/app/leads/import/page.tsx`
  - `tests/integration/import-commit.test.ts`
  - `docs/PHASE-2-M4-PROPOSAL.md`, `docs/PHASE-2-M4-REPORT.md`, `docs/runbooks/supabase-storage-setup.md`
- **Changed:**
  - `package.json` and `pnpm-lock.yaml` (`@supabase/supabase-js` pinned at `2.118.0`, 8 packages, passes the 7-day rule)
  - `src/env.ts`, `src/env.test.ts`, `.env.example`, `next.config.ts`, `eslint.config.mjs`
  - `src/platform/authz/permissions{,.test}.ts`
  - `src/modules/leads/{index,access,assignment}.ts`
  - `src/app/(app)/app/leads/page.tsx`
  - `tests/e2e/leads-routes.test.ts`
  - `docs/PHASE-2-PLAN.md`

## Checks run

Part 3 (all on local `crm_test`; nothing ran against `crm_dev`, Neon or Supabase):

| Check | Result |
|---|---|
| `import-flow.test.ts` (new): upload authorisation and verification, analysis, sheets, mapping, tampering, validation, dry run (including the DB constraint), confirm/attest, as-uploader import with round-robin and attach, crash/retry, one running import, same-file acknowledgement, revocation → pause → resume, cancel, cleanup (expiry, idempotency, forged entries), cross-org isolation | 22/22 |
| Affected integration suites: `import-job-schema` 23, `import-cleanup-role` 19, `import-commit` 9, `db-roles` 57, `cross-org-isolation` 16, `leads` 29, `assignment` 22, `members` 15, `worker-outbox` 5 | 217/217 together with `import-flow` (10 files, one run) |
| e2e `import-flow.test.ts` (new): built server + real worker + outbox + local fake Storage API. Full upload → verify → analyse → map → validate → confirm → import → results → issues CSV; single-use token and no overwrite; forged `orgId` ignored; role, anonymous and cross-org refusals | 2/2 |
| e2e regression (session-context refactor): `auth-routes` 22, `route-isolation` 31, `two-factor` 7, `leads-routes` 9 (M4 block updated: the page now has the upload form, still no secret) | 69/69 |
| Unit (all) | 515/515 |
| `pnpm typecheck`, `eslint .`, `pnpm format:check`, `pnpm build`, `pnpm build:worker` | Clean / succeeded |
| Bundle scan | `.next/server` and `.next/static` contain no `read-excel-file`, `csv-parse` or `unzipper-esm`; `.next/static` has no Supabase code |

Not run: the other integration suites (`leads-list`, `platform-support`, `teams-settings-audit`, `two-factor`), which no part 3 change touches. Also not run: the S1/S2 spikes and any managed-database run.


Part 2:

| Check | Result |
|---|---|
| `pnpm add --save-exact read-excel-file@9.3.12 csv-parse@7.0.3` | 7 packages added. The lockfile passes the supply-chain policy (7-day package age, `strictDepBuilds`) |
| `pnpm audit --prod --audit-level high` | No known vulnerabilities |
| `prisma validate`; `prisma migrate diff --from-schema … --to-schema …` (offline, no database); `prisma generate` | Schema valid; DDL generated; client generated |
| Unit (all, `pnpm test`) | 508/508 passed (499 before, plus 9 parser tests) |
| `pnpm typecheck`, ESLint (`src tests`), `pnpm format:check` | Clean |
| `pnpm build`, `pnpm build:worker` | Succeeded |
| Cleanup-role correction: `cleanup-grants.test.ts` 5/5, `env.test.ts` 9/9; unit suite, typecheck, ESLint, Prettier, `build:worker` re-run | See the correction section |
| Client bundle scan (`.next/static`) | No `read-excel-file`, `csv-parse` or Supabase code |

**Not run in part 2: any integration or e2e suite.** Their global setup applies every migration to `crm_test`, which would have applied `0005_imports` before this review. The part 1 results below still stand: apart from the shared test zip builder, part 2 changed no code those suites exercise.

Part 1:

| Check | Result |
|---|---|
| Unit (all, `pnpm test`) | 499/499 passed, including the new tests: storage adapter and keys 7, client boundary 2, file checks 19, mapping and rows 10, env +2, permissions +5 |
| Integration: new `import-commit.test.ts` (local `crm_test`) | 9/9 passed |
| Integration: affected `leads`, `assignment`, `leads-list` | 67/67 passed |
| E2E `leads-routes` (built server and worker) | 9/9 passed, including the new import-page access test |
| `pnpm typecheck`, ESLint (`src tests`), Prettier, `pnpm build`, `pnpm build:worker` | clean / succeeded |
| Client bundle scan (`.next/static`) | no Supabase code, URL or key |

Not run (no reason to): other integration suites, `route-isolation`, auth/2FA e2e, and any Supabase cloud test, since no project was used.

## Not done / remaining

**M4 is not signed off.**

Runbook §4 passed in full against the real bucket:
- step 1 (18/18) and step 1b (3/3);
- steps 2–5 over HTTP (55/55, plus cleanup 8/8);
- step 3 in a real browser, with CSV and XLSX.

**The only remaining acceptance gate is P6, the pilot files.** Synthetic-fixture validation passed on 2026-10-24 (see the section of that name) but does **not** satisfy P6.

**P6 attempt, 2026-10-24: blocked, no pilot file supplied.** No anonymised export was attached or present in the project (no CSV, XLSX, XLS, TSV or ZIP outside dependencies and build output). Other folders were deliberately not searched, so that the original customer export could not be opened by mistake. Nothing was validated. P6 remains open.

**P6 attempt 2, 2026-10-24: blocked, the folder is empty.** The owner reported the anonymised files as placed in `pilot/anonymised/`. That folder (created for this purpose, with a README and a `.gitignore` that excludes spreadsheet and archive files) contained only its `README.md` and `.gitignore`, with no subfolders or other files. No other folder was searched. Nothing was validated. P6 remains open.

The list below predates that run; item 1 is done. Open items, in order:

1. **Real Supabase bucket check (owner, manual):**
   - create the Mumbai-region project and the private `crm-imports` bucket (runbook §1–§2);
   - set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_IMPORT_BUCKET` in `.env` (§3);
   - rebuild with `SUPABASE_URL` set;
   - then run runbook §4 steps 1–5 with the synthetic files and record the results here.

   This may incur Supabase charges if a paid plan is chosen, which needs separate approval. The Free plan is enough for this check.
2. **Pilot files (P6):** real anonymised exports from a named brokerage, to validate the header aliases, vocabulary synonyms and phone and budget formats.
3. **Deferred, unchanged:**
   - saved mapping templates (FR-041);
   - "update empty fields" duplicate policy (FR-045 option 3);
   - a rejected-rows file with the original cell values (FR-047 is met with codes and headings only);
   - an in-app "import finished" notification (needs a `notification_type` CHECK change, so a separate approval);
   - an enquiry date column.
4. **Phase 2 exit (outside M4):** initial commit (P1), Phase 1 exit criteria and staging (P2), and the 100,000-row performance run on staging.

The worker's per-batch authorisation check covers membership, org status, role and permissions. Two-factor authentication is enforced by the web session on every request, including resume.
