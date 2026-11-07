# Phase 2 M6: 250,000-lead load test (plan, harness, preliminary local results)

> **Status (2026-10-26, second round, §8):** **preliminary local results only**. These numbers come from a laptop's Docker Postgres with synthetic data. They do **not** replace the staging acceptance with k6.
>
> **M6 has not passed.**
>
> **NFR-006 (300 rows/s):**
> - **The shipped default path fails:** 49 rows/s with P-A, P-B and P-F.
> - **The set-based prototype passes in a 1,000-row local sample:** 1,359 rows/s, about 140 ms per 200-row batch (§8.4). It is not the default; it awaits design review. It has not been measured on the 100k file or on staging.
>
> **Done this round:**
> - Migrations 0007 and 0008 promoted unchanged and applied to the local `crm_test` and `crm_dev` after verified backups (§8.1).
> - P-F implemented (§8.2).
> - The per-organisation search limit implemented (§8.3).
> - The `import-flow.test.ts` unhandled rejections fixed (§8.7).
>
> **Not completed (memory):**
> - the 100k / 20k-XLSX / re-upload / custom-field / 250k-comparison corpus checks: free memory never reached 4 GB (§8.6);
> - P-F measured alone in an import.
>
> §4–§7 are earlier runs, kept as they were measured.

## 1. Acceptance thresholds (from existing requirements; fixed before the results)

| Requirement | Threshold (server-side p95 at base workload unless stated) | Source |
|---|---|---|
| NFR-001 lead list | Filtered list page ≤ **500 ms**; search by phone fragment or name ≤ **700 ms**, on a 250k-lead org | non-functional-requirements §2; FR-056 |
| NFR-002 lead detail | Detail ≤ **400 ms**; first 50 timeline entries ≤ **300 ms** | NFR-002 |
| NFR-006 import | ≥ **300 rows/s per worker**; a 100k-row file complete ≤ **10 min** | NFR-006; roadmap Phase 2 exit |
| NFR-010 | No list returns more than 200 rows (page size is 25) | NFR-010 |
| Error rate | < 1% of requests (staging) | staging plan step 7 |
| Base workload | 25 orgs, 300 peak concurrent users platform-wide, ≤ 250k leads per org | NFR §1 |

Notes:
- NFR-001 is written for a 50-row page. The application ships a 25-row page (`LEAD_PAGE_SIZE`), and that is what was measured. The staging run should measure the page size as shipped, and the owner may confirm whether NFR-001's "50 rows" still applies.
- **These thresholds are not to be changed after results are known.**

## 2. Harness (synthetic only, reproducible)

| Piece | What it does |
|---|---|
| `scripts/perf/perf-db.mjs create\|status\|drop` | An **isolated** local database `crm_perf` in the Docker Postgres, using the approved recovery-drill method: owner `crm_migrator`, runtime roles get CONNECT, extensions, `crm_cleanup` CONNECT, migrations 0001–0006 via `prisma migrate deploy`. It verifies all five role identities by query. It never touches `crm_dev`/`crm_test`, and `drop` removes only `crm_perf` |
| `tests/support/synthetic-data.ts` | A deterministic generator (seeded PRNG; row i is always identical): fabricated names, example.test e-mails, made-up phone blocks, INR budgets, cities and localities |
| `scripts/perf/seed-perf.mts` | **Org A:** 250,000 leads, 4 teams, 40 sales executives plus Owner/Admin/Manager/HR, 8 sources. Each lead gets one enquiry and one CREATED activity, plus an open assignment when it is owned. 20 leads get 300 extra activities. Dates span 3 years, skewed recent. Stages, intents, cities and budgets follow realistic weights; 3% are archived.<br>**Org B:** 5,000 leads, for isolation checks.<br>Users are created through the real auth stack; bulk rows are inserted as the schema owner within every CHECK. **50 s** to seed |
| `scripts/perf/bench-leads.mts` | Calls the **real** code path (`searchLeads`/`getLead`/`getTimeline` → tenant transaction as `crm_app`, RLS + scope filter). Per scenario: **5 warm-up + 30 timed** calls → p50/p95/p99/max.<br>Then:<br>• 20-page cursor pagination;<br>• closed-loop concurrency (1/10/25 virtual users, 20–30 s, no think time);<br>• open-loop fixed arrival rates (5/10/20/30 req/s, 30 s each);<br>• memory (RSS) and app-pool connections;<br>• `EXPLAIN (ANALYZE, BUFFERS)` per scenario under RLS;<br>• tenant-isolation and scope checks on every returned row |
| `scripts/perf/import-run.mts` | The real import job (upload verification → analysis → mapping → validation → attested import), with the worker's step function, in-memory storage and the synthetic corpus. Per-phase timings, exact counts, a crash injected inside a batch then resume, re-upload of the same file |
| `scripts/perf/index-experiment.mjs` | Candidate indexes, **only** on the throwaway `crm_perf`, and their removal and verification |

**Run order:**
1. `node scripts/perf/perf-db.mjs create`
2. `pnpm exec tsx scripts/perf/seed-perf.mts <accounts.json>`
3. `pnpm exec tsx scripts/perf/bench-leads.mts <accounts.json> <results.json>`
4. `pnpm exec tsx scripts/perf/import-run.mts <accounts.json> <results.json>`
5. `node scripts/perf/perf-db.mjs drop`

The accounts file holds synthetic test credentials; keep it in a scratch directory.

## 3. Staging load profile (for k6 on staging; staging plan step 7)

- **Data:** the same seed method in staging (250k-lead org plus a second org), with ANALYZE before testing.
- **Warm-up:** 2 min at 25% of target rate. Results are discarded.
- **Steady state:** 10 min at the **base workload**. This is 300 concurrent users platform-wide; for one 250k-lead org, assume 50 active users at one request per 5 s each, about **10 req/s per org**. The mix is 60% list/filter, 25% search, 15% detail/timeline. Plus a **stress** step at 3× (30 req/s) to find the knee.
- **Repeats:** 3 runs, reporting the worst p95. Thresholds as in §1; error rate < 1%.
- **Observe:** p50/p95/p99 per scenario; error rate; DB CPU, connections and pool waits; web/worker memory; queue depth; zero cross-tenant rows (assert in the script).
- **Imports:** one 100k-row file (`corpus_large_100k.csv`) into the 250k org, with one worker. Also two concurrent imports in different orgs (zero duplicate open leads; FR exit criterion).

## 4. Preliminary local results (2026-10-26)

**Environment:**
- Windows laptop with 16 GB RAM; Docker Postgres 18.6.
- App code run in Node 24 against `crm_perf`, with the app pool at its default of 10 connections.
- `crm_perf`: 255,000 leads (A 250k, B 5k), 261,000 activities, 236,674 open assignments, 389 MB.
- Raw JSON results are kept with the harness output (not committed).

### 4.1 Single user (sequential, 5 warm-up + 30 timed)

| Scenario | p50 | p95 | p99 (ms) | DB time | Plan | Limit | Result |
|---|---|---|---|---|---|---|---|
| list: default (active, newest) | 13.5 | 19.1 | 21.1 | 1.0 | index (`lead_pkey`) | 500 | pass |
| list: oldest first | 14.3 | 30.8 | 31.1 | 0.1 | index | 500 | pass |
| list: **name A–Z** | 70.7 | **109** | 117.5 | **52.6** | **seq scan + sort** | 500 | pass |
| list: all incl. archived / archived only | 13.3 / 16.3 | 30.9 / 38.5 | 34.1 / 49.3 | 1–2 | index | 500 | pass |
| filter: stage (20% / 4% / 3 stages) | 12–14 | 19–22 | 22–27 | 1–1.4 | index | 500 | pass |
| filter: owner / unassigned / team / city / budget | 11–15 | 13–22 | 14–31 | ~1 | index | 500 | pass |
| filter: created (30 d / 2 y ago) / assigned (30 d) | 14–16 | 20–30 | 25–34 | 1–3 | index | 500 | pass |
| combo typical: stage + city + budget | 67.9 | 102.4 | 105.6 | 55.3 | bitmap + sort | 500 | pass |
| combo rare: stage + type + city + intent | 52.4 | 69.8 | 97.9 | 34.9 | bitmap + sort | 500 | pass |
| combo: owner + stage + created 90 d | 20.8 | 34.4 | 34.7 | 4.2 | index | 500 | pass |
| search: common surname (many matches) | 12.6 | 20.7 | 36.6 | 1.6 | index walk | 700 | pass |
| search: **exact name / e-mail / full phone / 6-digit fragment** | 237–279 | **260–344** | 261–378 | **238–319** | **walks the whole table** | 700 | pass (sequential) |
| search: no match | 209.3 | 250.1 | 291.4 | 190.2 | whole table | 700 | pass |
| search: 4-digit fragment | 156.3 | 172.8 | 189.2 | 221.7 | whole table | 700 | pass |
| pagination: 20 pages newest / **name** | 14.4 / 135.6 | 20.9 / **250.3** | 22.3 / 273.1 | — | — | 500 | pass |
| lead detail (40 leads incl. 20 with 300 activities) | 22.3 | 32.3 | 52.9 | — | — | 400 | pass |
| timeline (same leads) | 48.3 | 57.0 | 74.3 | — | — | 300 | pass |

### 4.2 Under load (mixed scenarios)

| Load | Requests | Errors | p50 | p95 | p99 (ms) | Slowest scenarios (p95) | App connections / RSS |
|---|---|---|---|---|---|---|---|
| open loop 5 req/s | 150 | 0 | 25.2 | 253.3 | 279.9 | searches ≤ 296 | — |
| open loop 10 req/s (≈ base workload for one org) | 300 | 0 | 24.8 | 262.9 | 282.8 | searches ≤ 305 | — |
| open loop 20 req/s | 600 | 0 | 23.4 | 377.4 | 464.2 | searches ≤ 490 | — |
| **open loop 30 req/s** (3×) | 900 | 0 | 29.7 | **648.8** | 801.7 | **searches 774–880 (> 700)** | — |
| closed loop 1 VU | 322 | 0 | 16.3 | 263.3 | 290.8 | — | 3 / 268 MB |
| closed loop 10 VUs (no think time) | 1,298 (43/s) | 0 | 44.0 | 1,060 | 1,336 | queueing behind full-table searches | 14 / 385 MB |
| closed loop 25 VUs | 1,197 (40/s) | 0 | 494.7 | 1,442 | 1,776 | saturated | 14 / 461 MB |

- **Tenant isolation:** every scenario was run as org B's Owner, org A's Manager (team scope) and an org A executive (own scope). 1,245 returned rows were checked: **0 failures**, and org B could not open an org A lead (NOT_FOUND).
- **Errors:** none in any run.
- **Connections:** the pool topped out at its 10 connections plus the harness's own; there were no connection errors, and requests queued in the pool.

### 4.3 Imports (100,000-row synthetic file, partial run)

| Measurement | Result | NFR-006 |
|---|---|---|
| Upload verification + analysis + validation of 100,000 rows (19.95 MB CSV) | ≈ **9 s** | — |
| Import (commit) rate, org B (5k leads; table ≈ 255k–350k rows) | **16.8 rows/s** (95,800 rows in 5,707 s) | ≥ 300 rows/s: **FAIL** |
| Import rate, org A (250k leads), XLSX, first run | ≈ **6 rows/s** | **FAIL** |
| Projected time for a 100k file | ≈ **1.6 h** (org B), ≈ 4.6 h (org A) | ≤ 10 min: **FAIL** |
| Crash inside batch 100, then resume | Resumed; **exactly 95,712 leads created** for the first 96,000 rows (all valid rows, nothing lost or doubled) | correct |
| Problem rows | 100 invalid and 100 in-file duplicates recorded, matching the corpus definition | correct |
| Duplicate open-lead phones after the run | **0** | correct |
| Earlier small imports (org A/B): custom fields 12 rows, variants 500, multi-sheet 150 | completed with the expected counts (custom fields: 3 valid, completed with errors) | — |

**Not completed:** Claude Code stopped the run because the machine ran low on memory. It was not restarted. Missing:
- the final 4,200 rows of the 100k file and its final count check;
- the 20k XLSX in org B;
- the re-upload test;
- the custom-field import in its final position;
- the org A per-row comparison with the experimental index.

The per-row costs were measured directly instead (§5).

## 5. Findings (evidence)

**F-1: under RLS, `LIKE`/`ILIKE` and `citext` comparisons cannot use any index.**
- **Why:** PostgreSQL applies a user condition as an index condition under row-level security only if its operator is LEAKPROOF. `textlike`/`texticlike` (LIKE/ILIKE) and `citext_eq`/`citext_lt`/`citext_ge` are **not** leakproof; `texteq`, `text_lt`, `text_ge` and `uuid_eq` **are**.
- **Shown in `crm_perf`:**
  - trigram GIN indexes on name/e-mail/phones make the same predicate take **1 ms as a superuser, which bypasses RLS**;
  - they are **never used as `crm_app`**: still 190–320 ms.
- **Not an option:** marking these functions LEAKPROOF would weaken the isolation guarantee, so it is **not** proposed.

**F-2: rare-match searches walk the whole `lead` table, across all tenants.** The plan walks `lead_pkey` in id order and filters, with the RLS org check applied per row. "Rows removed by filter: 255,000" means both orgs were read. Cost therefore grows with **total platform leads**, not the org's size: at the 6M-lead scale target it would be far worse than the 190–340 ms measured here.

**F-3: import commits are dominated by two per-row full-table scans.**
- **Measured as `crm_app`:**
  - **e-mail duplicate check** (M5, `citext` equality, no e-mail index): **52–145 ms** per lead with an e-mail;
  - **returning-customer lookup** (primary phone among WON/LOST leads; the only phone index is the partial open-lead one): **39–80 ms** per lead.
- **What is fine:** the open-lead phone match uses its indexes (0.1–0.3 ms).
- **Scaling:** both scans read the whole table regardless of org, so even a small org imports slowly once the platform is large. Manual lead creation pays the same cost (about 40–150 ms extra at this size).

**F-4: sorting by name is a full sort.** There is no `(org_id, full_name)` index: 52.6 ms in the database per page, and 250 ms p95 at page 20.

**F-5:**
- An explicit `org_id = $org` condition (leakproof `uuid_eq`) lets the planner use org-leading indexes when the org is a small share of the table. Org B's lookups halved (54→26 ms, 66→34 ms); no effect for org A, which is 98% of this table.
- It is cheap defence in depth and plan stability for many-tenant tables.

## 6. Proposals (first run)

> **Decisions (owner, 2026-10-26):**
> - P-A, P-B, P-C and P-D approved for local implementation and measurement on `crm_perf` only.
> - P-E decided: keep substring semantics; no LEAKPROOF marking, RLS bypass, unreviewed SECURITY DEFINER or cross-tenant path.
>
> Results are in §7. The table below is the original proposal text.

Experimental indexes and columns existed only in the throwaway `crm_perf` and were removed with it. Timings below are `EXPLAIN ANALYZE` as `crm_app` under RLS.

| # | Change | Kind | Evidence | Expected effect |
|---|---|---|---|---|
| **P-A** | Returning-customer lookup: add `phone_last10 = <last 10 digits>` and `org_id = <org>` to the existing primary-phone equality, so it uses the existing `(org_id, phone_last10)` index | **Application only** (no migration) | **47–54 ms → 0.2–1.1 ms** | Removes F-3's second scan from imports and manual create |
| **P-B** | E-mail duplicate check and exact-e-mail search on a normalised text column. **Migration:** `email_normalized text GENERATED ALWAYS AS (lower(email::text)) STORED` and index `(org_id, email_normalized)`. **App:** query `email_normalized = lower($1)` with `org_id` | **Migration + application** (needs approval as a schema change; no RLS/grant change; the new column inherits the table's policies) | **92–145 ms → 0.13–0.21 ms** | Removes F-3's first scan; M5 detection semantics unchanged (case-insensitive exact match) |
| **P-C** | Search: when the text is a complete Indian mobile number, match only by equality on `phone_last10`/`alternate_phone_e164` (and `org_id`), not the substring OR | **Application only** | **213 ms → 0.9 ms** (full-phone search) | The most common search in a phone-first CRM becomes index-only. Real names do not contain digits, so no practical behaviour change; the owner should confirm |
| **P-D** | Index `(org_id, full_name, id)` for "Name (A–Z)" sorting and its keyset pagination | **Migration** (index only) | **52.6 ms → 0.2 ms** DB time; 20-page p95 **250 → 24 ms** | Removes F-4 |
| **P-E** | Substring search (name, e-mail, phone fragments) remains a scan under RLS (F-1, F-2). Options for decision:<br>(1) accept and bound it: add `org_id` (F-5) and keep the 700 ms threshold, re-measuring on staging;<br>(2) prefix search on normalised text columns with leakproof range predicates (`>=`/`<`), served by btree;<br>(3) a separate search design.<br>**Not proposed:** LEAKPROOF marking, SECURITY DEFINER search functions or any RLS weakening | **Decision** | §4.1/4.2: passes sequentially and at 10–20 req/s; fails at 30 req/s | Determines whether NFR-001 search holds at 3× load |

**Re-measure:** after any approved change, rerun `bench-leads.mts` and `import-run.mts` on a fresh `crm_perf` against the same thresholds. P-A + P-B are expected to lift imports into the hundreds of rows/s, but that is **not yet demonstrated** and must be measured. Then run the staging k6 profile (§3).
> **Measured (§7):** they did not. P-A + P-B reached 14 rows/s.

## 7. Approved optimisations: implementation and local re-measure (2026-10-26)

Same laptop, Docker Postgres 18.6 and seed as §4 (255,000 leads; 389 MB before the proposed migrations). Synthetic data only.

**How the measurements were taken:**
- Every configuration ran on a **freshly recreated and reseeded `crm_perf`**, so each import sample wrote the same fresh rows. Identity (database, role) was checked before every operation.
- The proposed migrations were applied to `crm_perf` only, with the new `perf-db.mjs apply`.
- Heavy runs went one at a time, under a memory guard (exit code 3 below 1 GB free or above 3 GB RSS, never restarted).
- The thresholds in §1 are unchanged.

### 7.1 What changed

| # | Change | Files | Behaviour |
|---|---|---|---|
| **P-A** | Returning-customer lookup adds `org_id` and `phone_last10` to the existing primary-phone equality | `src/modules/leads/write.ts` | **Unchanged**: still primary against primary, among WON/LOST leads, not deleted, newest first. `phone_last10` is always the last 10 digits of `primary_phone_e164`: `insertNewLead` is the only writer of either column, and a test checks the invariant |
| **P-B** | Migration **0007** (proposed): `email_normalized` = stored generated column `lower(email::text)`, plus partial index `(org_id, email_normalized)`. The duplicate check queries `org_id = $org AND email_normalized = lower($1)` | `prisma/proposed/0007_lead_email_normalized`, `src/modules/leads/hygiene.ts` | **Unchanged**: case-insensitive exact match (both sides through PostgreSQL `lower()`, as citext equality does); NULL and blank e-mails never match; deleted and merged leads excluded; at most 10 cases; advisory lock and ON CONFLICT unchanged. **Not unique.** No RLS, policy, role or grant change. The database maintains the value on every write path, and a direct write is refused |
| **P-C** | A search text that is a complete, valid Indian mobile number (M0 normaliser, any accepted format) matches only `(phone_last10 AND primary_phone_e164) = number` or `alternate_phone_e164 = number`. Anything else keeps the substring search | `src/modules/leads/list-where.ts` | **Changed, as approved:** for a complete number, a lead whose **name or e-mail merely contains the digits** (e.g. `9876543210@gmail.com`) is no longer returned. Substring false positives also go: searching `9198765432` used to match `+919876543212`. Partial numbers are unchanged. Scope, RLS and the export filter (shared `filterWhere`) are unchanged |
| **P-D** | Migration **0008** (proposed): index `(org_id, full_name, id)` | `prisma/proposed/0008_lead_name_sort_index` | **None.** Same ORDER BY (`full_name ASC, id ASC`, default collation, id as tie-breaker, both NOT NULL) |
| **P-E** | No change (decision) | — | Substring search keeps its semantics and its scan cost (F-1, F-2) |

Harness additions:
- `perf-db.mjs apply` and `status` now list the proposed objects.
- `import-run.mts`: `sample` mode, memory guard, resource capture; the experimental index is replaced by a comparison against the proposed name index.
- `bench-leads.mts`: `--only`, `--no-load`, three full-phone scenarios outside the load mix, memory guard.
- `lookup-plans.mts`: the real `insertNewLead` as crm_app under RLS, EXPLAIN of each lookup, then rollback.
- `write-overhead.mjs`: rolled-back variants.
- `test-on-perf.mjs`.

### 7.2 Import throughput (NFR-006: ≥ 300 rows/s per worker)

1,000-row synthetic sample into org A (250k), with half the rows carrying an e-mail and every 20th reusing a seeded phone (959 created, 41 attached in every run). Commit phase only.

| Configuration (fresh seed each) | Import time | **Rows/s** | NFR-006 |
|---|---|---|---|
| Baseline (0001–0006, code as before) | 136.7 s | **7** | FAIL |
| P-A only | 97.2 s | **10** | FAIL |
| P-B only (0007; P-A reverted for this run) | 116.2 s | **9** | FAIL |
| **P-A + P-B** (the approved state) | 69.2 s | **14** | **FAIL** |
| P-A + P-B + **P-F experiment** (§7.6; not adopted, reverted after the run) | 33.7 s | **30** | FAIL |

Partial org B run (5k org, combined state, 100k file): 600 rows committed in about 35 s (≈ 17 rows/s) before the stop described in §7.7. That is a fragment, not a measurement of the file.

**The 300 rows/s target is not met.** A 100k file would take ≈ 2 h at 14 rows/s and ≈ 55 min at 30 rows/s, against the 10-minute limit.

### 7.3 Per-lookup query plans (crm_app, tenant transaction, RLS; real `insertNewLead`, rolled back)

20 samples each; every sample found its match; no probe lead was kept.

| Lookup | Org | Before: p50 / max (plan) | After: p50 / max (plan) |
|---|---|---|---|
| Returning customer (P-A) | A 250k | 41.6 / 53.0 ms (bitmap on `lead_org_id_team_id_stage_idx`, every closed lead, sort) | **0.07 / 0.15 ms** (Index Scan `lead_org_id_phone_last10_idx`) |
| Returning customer (P-A) | B 5k | 7.1 / 10.0 ms | **0.07 / 0.14 ms** |
| E-mail duplicate check (P-B) | A 250k | 61.8 / 92.7 ms (Seq Scan, parallel) | **0.06–0.09 / 0.08–0.23 ms** (Index Scan `lead_org_id_email_normalized_idx`) |
| E-mail duplicate check (P-B) | B 5k | 30.4 / 49.9 ms (Seq Scan) | **0.09–0.10 / 0.14–0.23 ms** |

### 7.4 Search and sort (sequential, 5 warm-up + 30 timed; threshold 700 ms search / 500 ms list)

| Scenario | Baseline p50 / p95 / p99 (DB ms) | After p50 / p95 / p99 (DB ms) |
|---|---|---|
| search: full phone (P-C) | 316.1 / 368.9 / 369.8 (302.9) | **18.4 / 23.0 / 24.8 (0.1)** |
| search: full phone, +91 spaced (P-C) | 316.2 / 370.0 / 406.9 | **17.6 / 21.0 / 22.0** |
| search: full phone, alternate number (P-C) | 312.7 / 376.9 / 417.0 | **16.7 / 28.0 / 38.2** |
| search: full phone, no match (P-C) | 314.2 / 409.4 / 416.1 | **17.8 / 24.6 / 27.0** |
| list: name A–Z (P-D) | 101.2 / 126.4 / 138.5 (73.0, seq scan + sort) | **21.2 / 27.0 / 27.3 (0.2)** |
| pagination: 20 pages by name (P-D), p95 | 125.6 | **28.2** |
| search: exact name (P-E, unchanged) | 343.6 / 409.5 / 417.3 | 335.7 / 392.9 / 417.2 |
| search: e-mail (P-E) | 336.1 / 383.8 / 387.3 | 334.4 / 372.4 / 409.1 |
| search: 6-digit fragment (P-E) | 298.7 / 323.2 / 368.4 | 286.1 / 317.1 / 320.5 |
| search: 4-digit fragment (P-E) | 187.0 / 208.0 / 210.5 | 184.3 / 204.5 / 229.7 |
| search: no match (P-E) | 273.1 / 319.1 / 331.2 | 267.8 / 287.9 / 334.1 |

Separately:
- **P-C alone** (no migrations): full phone 19.1 / 25.1 / 25.2 ms.
- **Before P-D** (0007 applied, no 0008): name sort 98.3 / 109.5 / 139.2 ms; 20-page p95 135.4 ms.
- Every other list and filter scenario passed in both runs, at 22–107 ms p95.

**Under load** (same mixed set as §4.2, which excludes the new full-phone scenarios):

| Load | Baseline today: p50 / p95 / p99 | After: p50 / p95 / p99 | Errors |
|---|---|---|---|
| open loop 5 req/s | 31.5 / 342.4 / 382.0 | 36.6 / 348.0 / 370.2 | 0 / 0 |
| open loop 10 req/s | 30.4 / 405.1 / 431.2 | 34.6 / 410.3 / 451.8 | 0 / 0 |
| open loop 20 req/s | 26.3 / 448.0 / 485.4 | 26.8 / 408.7 / 454.7 | 0 / 0 |
| open loop 30 req/s | 21.6 / 456.7 / 485.3 (slowest: exact name 499) | 21.0 / 437.1 / 471.4 (slowest: exact name 508) | 0 / 0 |
| closed loop 10 VUs | 838.9 p95 (58.4 req/s) | 833.5 p95 (69.2 req/s) | 0 / 0 |
| closed loop 25 VUs | 1,046.6 p95 (55.6 req/s) | 1,153.4 p95 (59.7 req/s) | 0 / 0 |

- **Variance, not an improvement claim:** today's 30 req/s runs (both baseline and after) stayed under 700 ms for every scenario. The §4.2 run measured 648.8 ms p95, with searches at 774–880 ms, on the same data.
- The mix's slowest requests are the unchanged substring searches (P-E), which dominate p95 in both runs.
- **The §4.2 failure at 30 req/s stands as a documented limitation.** One passing local run does not overturn it, and the threshold is not changed.
- **Resources:** bench process peak RSS 258–483 MB; app pool 10 connections, peak 14 with the harness; Postgres container 237–401 MB.
- **Tenant isolation:** org B owner, org A manager (team scope) and org A executive (own scope); 1,246 returned rows checked, **0 failures**; org B gets NOT_FOUND for an org A lead.
- **Focused runs:** 165 rows (P-C state) and 225 rows (P-D state) were checked, 0 failures.

### 7.5 P-E: the per-organisation rate limit

**There is no per-organisation (or per-user) rate limit on lead list or search** to verify:
- the shared limiter (`src/platform/rate-limit`) is used only for invitations, 2FA reset and sensitive settings, the export daily cap, and Better Auth's sign-in endpoints;
- NFR-046's "imports 10/h/org" is not implemented either;
- `searchLeads` and `/app/leads` call no limiter.

So "verify the limit is enforced at the planned budget" **cannot be done**. Nothing was added: a new limit changes user-visible behaviour (RATE_LIMITED responses), and its budget is a product decision. §3's 10 req/s per org is a workload assumption, not a limit.

**Owner decision needed:**
- **(a)** approve a per-org search limit with a stated budget, for example 30 searches/s per org with a burst, via the existing Valkey limiter, applied only when `q` is present; or
- **(b)** accept unbounded substring search, sized by §4.2/§7.4 and re-measured on staging.

Substring semantics, RLS and grants are untouched either way (F-1, F-2 remain).

### 7.6 Next bottleneck (evidence) and the next smallest safe change

**Profile:** every statement was logged on `crm_perf` only, with `log_min_duration_statement = 0` (reset afterwards), during a 200-row sample in the P-A + P-B state.
- Statements took **9.8 s** of the 15.3 s import.
- **9.3 s of it was one query, the open-lead phone match** (`findOpenMatch`): 200 calls, 46 ms average, 70 ms max.
- Every other statement totalled < 0.6 s.

**Cause:**
- Prisma binds the stage list as `stage NOT IN (CAST($1::text AS lead_stage), …)`. The text-to-enum cast is stable, not immutable, so it is not folded at plan time.
- The planner therefore cannot prove the partial unique index `lead_open_phone_uq` (`WHERE stage NOT IN ('WON','LOST') …`) applies. There is no other index on `primary_phone_e164`, so it reads about 84k candidate leads of the org.
- The same text with literal stages uses the index (0.1–0.3 ms). That is why the earlier per-row measurement (§5 F-3) reported 0.1–0.3 ms.

**Proposed P-F (application only, needs approval):**
- **Change:** add `phone_last10 IN (<last 10 digits of each phone>)` to the primary-phone branch of `findOpenMatch`. This is the same reasoning as P-A: semantics unchanged under the `phone_last10` invariant.
- **Effect on the query:** the plain `(org_id, phone_last10)` index serves it, with no partial-index proof. Prisma's exact text: **47–55 ms → 0.16–0.44 ms**.
- **Effect on imports:** measured once and then reverted, **14 → 30 rows/s**.
- **Also covers:** manual create and the "report duplicate" path, which use the same lookup.

**After P-F, the limit is round trips, not the database:**
- Remaining cost ≈ 34 ms per row, of which the database executes ≈ 2.7 ms.
- Measured on this laptop: one statement costs **1.65 ms** with raw `pg` and **2.8–3.4 ms** through the app's Prisma interactive transaction.
- A created lead issues ≈ 10 sequential statements: done-check, open match, insert, returning lookup, e-mail lock, e-mail lookup, enquiry, stage history, activity, and the assignment when owned.
- **300 rows/s needs ≤ 3.3 ms per row**, i.e. set-based statements per batch (500 rows), not per row. That is a design change to `commitImportBatch`, not an index. Outline for a separate proposal:
  - one query each per batch for done-checks, open matches, returning matches and e-mail matches;
  - multi-row inserts for leads, enquiries, history and activities;
  - the same rules, locks (`lockPhones` already covers the batch) and per-row outcomes.
- Staging latency (managed Postgres over a network) decides the real round-trip cost. NFR-006 must be measured there.

### 7.7 Resources and the corpus checks (not completed)

The full corpus run (combined state) was **stopped by Claude Code because the system ran critically low on memory**:
- its import process held 781 MB working set, after loading and validating the 100k file;
- the machine had about 1.9 GB free;
- the run's own guard (1 GB) had not fired.

How it ended:
- The orphaned worker was stopped. The interrupted batch rolled back, and no connection was left.
- The job was consistent: `next_row` 600, 597 created, exactly 597 new leads, 0 duplicate open-lead phones.
- **It was not restarted.**

Still **not completed** (same list as §4.3):
- the 100,000-row file to the end, with its crash and resume;
- the 20,000-row XLSX;
- re-upload idempotency;
- the custom-field import in its final position;
- the org A import with and without the name index.

They need a machine with more free memory, or staging. At ≈ 14–17 rows/s the 100k file alone would run ≈ 2 h.

**Third attempt (2026-10-26, 12:03 IST): stopped by the memory guard, not restarted.**
- **What ran:** a new `rest` mode of `import-run.mts` (steps 2–6 above, without the 100k file). It ran on a freshly created and seeded `crm_perf` (255k leads) with 0007 and 0008 applied (4.8 s and 1.1 s), so the combined state was tested.
- **Why it stopped:** at the start the machine had 1.71 GB free. Other applications on the laptop, not part of this project, hold about 1.8 GB. Our guard stopped the run 16 s into committing the 20k XLSX: free memory 973 MB, the run's own process at 436 MB.
- **Completed:** none of the checks.
- **Cleanup:** no process or connection was left. `crm_perf` was dropped.
- **The 100k file itself was not attempted.** The earlier stop occurred at about 1.9 GB free with that run at 781 MB, and the same conditions held.
- **To run them:** free at least about 4 GB (or use a larger machine or staging), then run `import-run.mts … full` on a fresh `crm_perf` with 0007/0008.

### 7.8 Migration cost, write overhead and storage (`crm_perf`, 255k leads)

| | 0007 (P-B) | 0008 (P-D) |
|---|---|---|
| Apply time | **3.0–3.2 s**: table rewrite under ACCESS EXCLUSIVE (adding a STORED column) | **1.1 s** (plain CREATE INDEX; use CONCURRENTLY on a populated production table) |
| Storage (clean, after VACUUM FULL) | heap 76 → 80 MB (+5%; e-mail is set on 126,689 leads, 32.5 B average); index 9.1 MB (partial) | index 21 MB |
| Write cost, 2,000 single-row INSERTs (median of 3, rolled back) | 160 → 162 µs/row (+1%) | 160 → 176 µs/row (+10%) |
| Write cost, one 20,000-row INSERT … SELECT | 798 → 886 ms (+11%) | 798 → 1,002 ms (+26%) |
| Both together | single row 182 µs/row (+14%); bulk 1,113 ms (+39%) | |

- **In context:** the extra ≈ 22 µs per lead is < 0.1% of the current ≈ 34–70 ms per imported row.
- All lead indexes total 92 MB for 255k leads.
- The read gains are in §7.3/§7.4.

### 7.9 Tests

- **Unit:** `src/modules/leads` 226/226, including the new `list-where.test.ts` (P-C path selection). Typecheck clean.
- **Integration, new `tests/integration/m6-lookups.test.ts`: 20/20.** Run on a fresh, unseeded `crm_perf` with 0001–0008 (`scripts/perf/test-on-perf.mjs`; not `crm_test`, which lacks 0007/0008). It covers:
  - **P-A:** primary match in another format; alternate numbers never link, either way; several closed leads (newest live wins, deleted ignored); tenant isolation; the `phone_last10` invariant; the plan under RLS.
  - **P-B:** case-insensitive match; null and blank never match; a contained address does not match; deleted excluded; tenant isolation; the column follows every write and cannot be written by crm_app; the plan under RLS.
  - **P-C:** every accepted format; primary, alternate and closed leads; the documented e-mail-contains change; partial numbers unchanged; scope and tenant isolation; the plan.
  - **P-D:** collation-sensitive names and 30 ties paginate exactly as `ORDER BY full_name, id`; index order with no Sort node.
- **Full integration suite on `crm_perf`:** see §7.10.
- **Not run:** e2e (needs the app server against a database with 0007).

### 7.10 Full integration suite on `crm_perf` (0001–0008)

Run on a fresh, unseeded `crm_perf` (0001–0006 plus proposed 0007, 0008) with `node scripts/perf/test-on-perf.mjs`; the storage URLs were blanked.
- **First run: 440/441.** The failure came from the new test file, not the application. `m6-lookups` inserted two owned leads directly without their M3 creation spell, and the 0004 backfill test counts spells across the database (357 vs 355). Fixed in the test by writing the spell, as real leads have one.
- **Rerun: 23/23 files, 441/441 tests, 257 s.**
- Vitest still exits 1 because of **3 unhandled rejections ("Import not found") from `import-flow.test.ts`**, "another org's Owner cannot see or act on an import".
  - Pre-existing test code: it creates seven rejecting promises before awaiting them one by one.
  - Every assertion passes with NOT_FOUND, which is the expected isolation result.
  - Not changed here; recorded as a test-hygiene item.
- **Resolved in §8.7.**

## 8. Second round: promotion, P-F, search limit, set-based prototype (2026-10-26)

Same laptop, Docker Postgres 18.6 and synthetic seed as §7: 255,000 leads, now created with 0001–0008 by `prisma migrate deploy`. Every configuration ran on a freshly recreated and seeded `crm_perf`. Identity was checked by query before every database operation. Thresholds (§1) unchanged.

### 8.1 Migrations 0007 and 0008 promoted to the local `crm_test` and `crm_dev` (Part A)

| Check | Result |
|---|---|
| Reviewed SQL | 0006 (the reviewed M5 migration), 0007, 0008. Collation of `lead.email` and `full_name` is the database default (`en_US.utf8`, libc) on both databases, so `lower(email::text)` is what citext equality compares. No blank or untrimmed e-mails |
| Status before | `crm_test` 0001–0006, `crm_dev` 0001–0005. Recorded checksums of 0001–0006 equal the files' SHA-256 on both |
| Identity | By query through the migrator URL: `current_database()`, `current_user = crm_migrator`, and the cluster `system_identifier` (7698432437111361579), which equals the one read inside `cbr-crm-postgres-1`. Not the other Postgres on the machine (port 5454) |
| Backups | `pg_dump -Fc` of each database plus `pg_dumpall --roles-only --no-role-passwords`, in the session scratch directory `backups-20261026/`: `crm_test` 242,487 B, `crm_dev` 185,701 B. Each was read in full with `pg_restore` (28 and 25 table-data entries) |
| Promotion | Both folders moved to `prisma/migrations/`, byte-identical (SHA-256 `4f26dbdc…`, `d241074b…`). `schema.prisma` gains `@@index([orgId, fullName, id])`. `email_normalized` stays out of the model (raw-SQL object, `prisma/README.md`) |
| Applied | `crm_test`: 0007, 0008. `crm_dev`: 0006, 0007, 0008 in order. `prisma migrate deploy` as crm_migrator; `migrate status` "up to date" on both |
| After | Checksums recorded. `email_normalized` = `lower(email::text)` for every row (0 mismatches; NULL e-mail → NULL). Both indexes present and valid, RLS ENABLE + FORCE unchanged, no new column grant for `crm_app` |
| Compatibility | Focused lead-creation and duplicate tests on `crm_test`: m6-lookups, leads, m5-completion, lead-archive-review, hygiene-schema, **148/148** |

### 8.2 P-F: open-lead phone match (Part B)

**Change:** `findOpenMatch` (`src/modules/leads/access.ts`) sends the same predicate and order as raw SQL with the stage list as a literal (`stage NOT IN ('WON','LOST')`).

**Why this form:**
- The cause (§7.6) was Prisma's `CAST($n::text AS lead_stage)`. It is not folded at plan time, so the partial unique index `lead_open_phone_uq` could not be proven usable.
- With literals, `lead_open_phone_uq` serves the primary branch and `(org_id, alternate_phone_e164)` the alternate branch, through a BitmapOr. Both are existing indexes.
- The §7.6 proposal (adding `phone_last10 IN …`) was **not** used. It is only equivalent while `phone_last10` equals the last 10 digits of the primary phone, and `crm_app` can update the two columns independently. The literal form needs no such invariant.

**Unchanged:**
- primary and alternate phones match in every direction;
- open = not WON/LOST, not deleted, not merged; archived leads still match (flagged);
- oldest first; tenant from RLS;
- the phone locks and the `lead_open_phone_uq` backstop.

**Lookup alone** (`scripts/perf/open-match-bench.mts`): `crm_app` under RLS, 5 warm-up + 50 timed. Same answer before and after in every case.

| Org | Case | Before p50 / p95 / p99 (DB) | After p50 / p95 / p99 (DB) | Plan after |
|---|---|---|---|---|
| A 250k | open primary | 38.6 / 43.9 / 44.7 ms (37.2) | **0.90 / 1.47 / 1.77 ms (0.06)** | BitmapOr: `lead_open_phone_uq` + alternate index |
| A 250k | open alternate | 38.4 / 59.2 / 66.3 ms (36.4) | **0.79 / 1.30 / 1.51 ms (0.05)** | same |
| A 250k | no match | 40.9 / 52.9 / 54.0 ms (51.2) | **0.96 / 1.53 / 2.28 ms (0.05)** | same |
| B 5k | open primary | 6.8 / 12.3 / 13.1 ms (9.2) | **1.53 / 2.30 / 2.34 ms (0.09)** | same |
| B 5k | no match | 7.5 / 11.8 / 15.2 ms (5.6) | **0.97 / 2.66 / 2.98 ms (0.20)** | same |

"Before" used `lead_org_id_team_id_stage_idx` and filtered every open lead of the org.

**Import (row strategy, 1,000-row sample, org A 250k):**
- P-A + P-B: **14 rows/s** (§7.2, same harness and seed, earlier the same day).
- **P-A + P-B + P-F: 49 rows/s** (20.4 s): 959 created, 41 attached, 0 duplicate open phones.
- P-F alone, in an import, was **not measured** (memory, §8.6). Only the lookup measurement above isolates it.

**Tests** (`tests/integration/m6-lookups.test.ts`, 27/27, 7 new):
- primary in any format;
- alternate in every direction;
- won, lost, deleted and merged excluded; archived flagged;
- oldest wins across phones;
- tenant isolation;
- 8 concurrent creates sharing one number as primary or alternate → 1 lead, 7 duplicates;
- the plan under RLS.

The existing import concurrency tests (`import-commit`, `leads`) pass unchanged.

### 8.3 Per-organisation search limit (Part C)

**What it does:**
- **Budget:** at most **10 lead text searches per second per organisation** (`src/platform/rate-limit/search-budget.ts`), across all app instances.
- **Mechanism:** a sliding-window log in one Lua call on the existing Valkey, on Valkey's own clock (`TIME`). A fixed window would admit 20 across a window edge. Refused requests are not recorded.
- **Key:** `rl:lead-search:org:<org uuid>`. The id is validated as a lowercase UUID, so keys cannot collide.
- **Where it applies:** the Next.js proxy (`src/platform/http/search-gate.ts`, called from `src/proxy.ts`), because results stream inside the page after the status line, so a page cannot answer 429. It applies only to `GET /app/leads` with a non-blank `q`. Filters, sorting and paging without text run no substring scan and are not metered.
- **Organisation:** the caller's active organisation from the normal session resolution. Requests the page would refuse anyway (no active org, suspended) are not counted.

**Responses:**
- **Over budget:** **HTTP 429**, `Retry-After` in whole seconds (1 at this budget), `Cache-Control: private, no-store`. The small HTML page names neither the organisation nor the query.
- **Limiter unavailable, failing closed:** a Valkey error, no answer within 300 ms, or an error resolving the organisation gives **HTTP 503**, `Retry-After: 5`. The search does not run. There is no unmetered fallback and no per-process counter.

**Unchanged:** substring semantics, RLS, grants. No LEAKPROOF marking and no SECURITY DEFINER.

**Tests:**
- **Unit, 29** (gate, budget failure paths, proxy): what is metered; 429 and 503 shape; errors fail closed; no org → not counted; key validation; timeout ≤ 1 s.
- **Integration against the real Valkey, 9/9**:
  - ordinary 5/s for 3 s → all pass;
  - boundary: 10th passes, 11th gets 429 with Retry-After 1;
  - 40 concurrent over two connections → exactly 10 pass;
  - org isolation: A exhausted, B untouched, separate keys;
  - retry: refused requests do not extend the wait; after Retry-After, 10 pass;
  - sliding: 0.6 s after 10, none pass;
  - keys expire within the window;
  - an unreachable Valkey → 503 within the timeout.
- **Not run:** e2e through the built server. It needs `pnpm build`, and the machine lacked the memory (§8.6).

### 8.4 Set-based import commit: design and prototype (Part D)

**Design:** [PHASE-2-M6-SET-BASED-IMPORT.md](PHASE-2-M6-SET-BASED-IMPORT.md).

**Prototype:**
- `src/modules/leads/importing-set.ts`, selected by `strategy: 'set'` (processor `commitStrategy`, harness `PERF_COMMIT_STRATEGY`).
- **The default stays `'row'`.**
- No migration, function, table, grant or policy. Every statement runs as `crm_app` under RLS.

**Correctness:**
- **Differential test** (`tests/integration/import-set-equivalence.test.ts`, 6/6). Twin organisations got identical existing leads and identical batches, with `row` in one and `set` in the other. Every outcome, and every lead, enquiry, stage-history row, spell, activity, note, duplicate case, outbox event and round-robin state, is **identical** once ids are labels. The batches cover:
  - new rows;
  - attaches (primary, alternate, archived → review case);
  - returning customers;
  - e-mail cases (case variants, more than 10 candidates, earlier rows of the same batch);
  - a match with a lead created earlier in the batch;
  - notes, requirements, invalid and required custom fields;
  - re-run → ALREADY_IMPORTED;
  - SKIP policy;
  - round-robin and target assignment.

  The twins share phone numbers, so a tenant leak would have shown.
- **Concurrency, crash and isolation** (`tests/integration/import-set-concurrency.test.ts`, 6/6):
  - two imports of the same 30 phones in opposite orders → 30 leads, no deadlock;
  - the same 15 e-mails in opposite orders → no deadlock, 15 cases. The row path takes e-mail locks in file order and can deadlock here;
  - manual create racing an import → one lead;
  - a crash after the writes rolls everything back; the retry writes the batch once; a second run reports ALREADY_IMPORTED;
  - another org's open lead, closed lead and e-mail never match;
  - another org's source is refused.

**Throughput** (1,000-row sample into org A, 250k; fresh seed each):

| Configuration | Import time | Rows/s | Per 200-row batch | NFR-006 (≥ 300) |
|---|---|---|---|---|
| Baseline, row (§7.2) | 136.7 s | 7 | ≈ 27 s | FAIL |
| P-A + P-B, row (§7.2) | 69.2 s | 14 | ≈ 14 s | FAIL |
| **P-A + P-B + P-F, row (shipped default)** | 20.4 s | **49** | ≈ 4.1 s | **FAIL** |
| **P-A + P-B + P-F, set (prototype)** | 0.7 s | **1,359** | **≈ 0.14 s** (budget 0.67 s) | **PASS locally** |

- Both strategies: 959 created, 41 attached, 0 duplicate open-lead phones.
- End to end (upload, analysis, validation and import): 926 rows/s with `set`.
- Process RSS: 281 MB (`set`) and 324 MB (`row`).

**Stage measurements** (`scripts/perf/stage-profile.mjs`): one 1,000-row `set` sample with fresh rows (offset 2000) on a freshly seeded `crm_perf`. The statement log was enabled on `crm_perf` only, with `ALTER DATABASE … SET log_min_duration_statement = 0`, and reset afterwards (verified).

Server time is parse + bind + execute, averaged over the 5 batches. The averages also include the job's own analysis and validation statements, and the harness's sign-in, so they overstate the commit itself.

| Stage (design §3) | Server ms per batch | Statements per batch |
|---|---|---|
| Insert leads (one multi-row INSERT) | 15.2 | 1 |
| Open matches (one LATERAL query) | 13.7 | 1.2 |
| Job lock, row results, progress (processor) | 8.8 | 10.8 |
| Insert enquiries | 8.4 | 1 |
| Activities | 7.0 | 1 |
| Transaction and tenant context (BEGIN, `set_config`, COMMIT; whole job) | 6.4 | 26.8 |
| Stage history | 4.0 | 1 |
| Returning-customer lookup | 3.0 | 1 |
| Done check | 1.4 | 1 |
| E-mail candidates / e-mail cases | 1.3 / 0.3 | 1 / 0.4 |
| Phone and e-mail locks | 0.8 | 2 |
| Custom fields, sources, assigner, outbox | 2.3 | 7.6 |
| Harness sign-in and job reads (not the commit) | 22.7 | 17 |
| **Total** | **95.5** | **72.8** |

- **Client wall time:** 140 ms per 200-row batch (1,423 rows/s), against the 670 ms budget.
- **The rest is round trips and Prisma:** the ≈ 45 ms not spent in the server, plus about 15–20 commit statements per batch.
- **Earlier profile runs** (1,257 and 1,488 rows/s) agree. The first two of the three runs undercounted statements because the profiler's log read was truncated at 1 MB; that is fixed.

**Not yet shown:**
- that this holds on the 100k file or with round-robin assignment at scale;
- staging. Network latency multiplies the ≈ 20 commit statements per batch: at 5 ms per round trip that adds ≈ 100 ms per batch, still inside the budget, but it must be measured there.

### 8.5 Reads and write overhead

- **Reads:** list, search and detail are unchanged by this round. P-F is a write-path lookup, and the search limit runs before the page. §7.4 stands. The 30 req/s substring-search limitation of §4.2 now sits above the 10/s per-org budget.
- **Write overhead of 0007/0008:** as measured in §7.8. Today's apply times on the seeded `crm_perf`: 0007 4.8 s (table rewrite), 0008 1.1 s.
- **The set path:** writes the same rows. Its inserts are multi-row, so index maintenance per row is the §7.8 bulk figure.

### 8.6 Memory and the import corpus (Part E)

**Free memory never reached the required ≈ 4 GB this session.** It ranged from 0.3 to 2.9 GB.

The main consumers were not this project:
- another project's Next.js dev server (PID 14064), 1.1 → 3.8 GB;
- its Nest server (PID 1576), about 1.1 GB;
- the Docker/WSL VM, 1.3–2.6 GB.

They were not stopped: only processes started by this run may be.

| Event | What happened |
|---|---|
| Corpus checks (100k CSV to the end, 20k XLSX, re-upload, custom fields last, 250k comparison) | **Not run.** Below the 4 GB threshold all session |
| Row sample, P-A + P-B + P-F | Completed. Minimum free memory 1.58 GB |
| First set sample | **Stopped by the harness guard**: free memory 0.59 GB → 320 MB while the other dev server grew. Not restarted |
| Second set sample (later, 2.35 GB free at start) | Completed. Ended at 477 MB free. `crm_perf` was dropped right after |
| A sample attempt at 1.1 GB free | Refused by the run script (needs ≥ 1.5 GB at start); nothing was started |

- After every stop: no process from this run remained, no `crm_perf` connection remained, and `crm_perf` was dropped.
- **To finish:** free ≥ 4 GB (for example by stopping the other project's dev servers), then run:
  1. `import-run.mts … full` with `PERF_COMMIT_STRATEGY=row` and then `set`, each on a fresh `crm_perf`;
  2. `stage-profile.mjs` with `row` for comparison (the `set` profile ran; §8.4).

### 8.7 Tests and verification

**`import-flow.test.ts` unhandled rejections: fixed.**
- **Cause:** the cross-org test created seven rejecting promises at once and awaited them one at a time.
- **Fix:** each call now starts only when awaited. Assertions are unchanged (all NOT_FOUND).
- **Result:** 22/22, and Vitest exits 0.

| Suite | Result |
|---|---|
| Unit: leads, imports, platform, proxy, test support | 29 files, **502/502** |
| Integration, affected files on `crm_test` (now 0001–0008): imports (commit, flow, pilot fixture, job schema), custom fields, leads, leads list, m5-completion, archive/review, merge, hygiene schema, cross-org isolation, db roles, m6-lookups, search budget, set equivalence, set concurrency | 17 files, **349/349**, Vitest exit 0 |
| Typecheck, lint (`src`, `tests`, `scripts/perf`), Prettier | clean |
| Not run | e2e (needs `pnpm build`; memory); unrelated integration files |

### 8.8 Remaining blockers and bottlenecks

1. **NFR-006 on the default path:** 49 rows/s. The set-based commit needs design review before it becomes the default. After that, it needs the 100k measurement and staging.
2. **Corpus checks:** need ≈ 4 GB free locally (§8.6).
3. **Search:** substring search still costs 180–390 ms p95 per request (F-1/F-2). It is now capped at 10/s per org.
4. **Memory of the 100k import itself** (781 MB RSS, §7.7): design §6 proposes releasing the parsed file after planning. Not implemented.
5. **Staging (P2) is open.** Nothing here counts as staging acceptance.

## 9. Set-based promotion: acceptance attempt (2026-10-26)

**Owner decision (2026-10-26):** make the set-based importer the default **after** the outstanding local acceptance checks pass. Keep the switch and the row path for rollback until then.

**Outcome: not started, blocked by memory. The default is NOT promoted.**
- The production default is still `strategy: 'row'` (`src/modules/leads/importing.ts`; processor `commitStrategy ?? 'row'`).
- `'set'` is selectable only explicitly.

**Memory at the start:**
- 2.53 GB free, then 2.55 GB on recheck, of 15.7 GB.
- Main holders: the Docker/WSL VM at 2.7 GB (this project's containers plus another project's `afx-postgres-dev` and `afx-redis-dev`), and Chrome at about 2.3 GB across processes.
- The other project's Node dev servers were small at the time (PIDs 14064 and 1576; earlier this day up to 3.8 GB and 1.1 GB).
- Per the owner's rule (≈ 4 GB free before corpus or E2E runs), nothing was started. No unrelated process was stopped, and there was nothing to clean up (no `crm_perf`, no workers).

**Still outstanding, all required before promotion:**
1. The 100,000-row CSV to the end: `import-run.mts … full`, `PERF_COMMIT_STRATEGY=set`, fresh `crm_perf`. Then the reconciliation of counts with `pilot/synthetic-corpus/manifest.json`, and the re-run to confirm no duplicate leads or enquiries.
2. The 20,000-row XLSX.
3. Re-upload idempotency (same file flagged; refused without acknowledgement; no duplicate leads).
4. The custom-field import in its final position.
5. The 250,000-lead comparison after the index changes, with average batch duration against 0.67 s.
6. Built-application E2E (`pnpm build`, then the e2e project with fake storage) for the set path:
   - normal import, validation failures, duplicates, retries, crash recovery, concurrency, tenant isolation.
7. Built-application E2E of the search limit:
   - 10/s per org; 429 with `Retry-After`; 503 with `Retry-After` with Valkey unavailable; per-org counter isolation.
   - The e2e suite needs new tests for this, and the set strategy must be selectable in the e2e worker (for example through an environment switch).

**Resources needed:**
- **At least 4 GB free** for the corpus runs: the import process reached 781 MB on the 100k file, plus seeding and Postgres growth.
- **About 6 GB free** for the E2E step: the Next.js production build, then the standalone server, worker and Vitest together.
- **Ways to get there:**
  - stop the other project's dev servers and its Docker containers (owner's decision);
  - close browser tabs;
  - or run on a machine with more free memory.

**Second acceptance attempt (2026-10-26): blocked by memory again; nothing started.**
- **Free memory:** 3.34 GB of 15.7 GB, below the 4 GB corpus threshold and the 6 GB E2E threshold. Main holders: the Docker/WSL VM at 1.8 GB, and Chrome at about 2.3 GB.
- **Not stopped:** no unrelated process or container.
- **Not written yet:** the missing E2E tests and worker switch are to be added when the memory is available, per the owner's instruction.

| Check | Status |
|---|---|
| 100k CSV to the end, reconciled with the manifest | **Blocked** (memory) |
| 20k XLSX | **Blocked** (memory) |
| Re-upload idempotency | **Blocked** (memory) |
| Custom fields in final position | **Blocked** (memory) |
| 250k throughput and batch duration (corpus scale) | **Blocked** (memory); 1,000-row samples only (§8.4) |
| Built-app E2E, set-based import | **Blocked** (memory); tests not yet written |
| Built-app E2E, search limit | **Blocked** (memory); tests not yet written |
| Promotion of `'set'` to the default | **Not done**: the default remains `'row'` |



## 10. Acceptance suite: prepared, NOT run (2026-10-26)

Free memory was 2.0–3.3 GB, below the 4 GB (corpus) and 6 GB (production-build E2E) thresholds. Per the owner's instruction, the acceptance tests and worker configuration below were **written only**.

**Nothing was run:**
- no unit, integration or E2E test;
- no build, no service, no import, no benchmark, no database operation.

Only static checks ran: Prettier, ESLint and `tsc --noEmit`, all clean.

**None of these checks has passed yet. The default importer is still `'row'`.**

### 10.1 Selecting the set-based worker

| Where | What |
|---|---|
| `src/env.ts` | `IMPORT_COMMIT_STRATEGY`: `row` (default, also when blank) or `set`. Any other value fails validation, and the worker refuses to start. After promotion it stays as the rollback switch |
| `src/worker/main.ts` | Passes it to `processImportJob` (`commitStrategy`). Logs `import commit strategy` at start and the strategy on every import step |
| `tests/e2e/server.ts` | **`E2E_IMPORT_COMMIT_STRATEGY=row\|set`**, validated before anything starts (any other value stops the run). It is passed **only to the worker**. An `IMPORT_COMMIT_STRATEGY` in `.env` is stripped, so the e2e run uses the explicit value or the application default. The value is provided to tests as `inject('importCommitStrategy')` |
| `tests/e2e/server.ts` | The worker is supervised (at most 3 restarts) and its pid is kept in `%TEMP%\cbr-crm-e2e-worker.pid`, so the crash test can kill it and the run continues. `spawnWeb(port, env)` starts extra built web servers |
| `tests/e2e/http.ts` | `Browser.base` sends the same session to another server instance |
| `src/env.test.ts` | Default `row`; blank → `row`; `set` accepted; `SET`, `sets`, `batch`, `true`, `1`, `' set'` refused |

The production default and the reviewed row path are unchanged. No migration, role, grant or policy is involved.

### 10.2 `tests/e2e/import-set.test.ts` (built app plus real worker, fake storage)

Every scenario asserts persisted state: import job counters, row results, leads, enquiries, cases, spells and notifications.

| # | Scenario | Assertions |
|---|---|---|
| — | Strategy | `inject('importCommitStrategy')` equals the selected `E2E_IMPORT_COMMIT_STRATEGY` |
| 1, 10 | `corpus_variants.csv` (500) and `corpus_multisheet.xlsx` sheet "Leads Q4" (150, via sheet choice) | File SHA-256 = manifest. Counters = manifest expectations. Created + attached + skipped + failed = valid. Row-result counts per outcome = counters. One enquiry per created or attached row, with distinct external ids. Attached results point at their enquiry's lead. 0 duplicate open phones. Lead delta = rows |
| 2, 4, 10 | `corpus_custom_fields.csv` with the corpus definitions | Validation results equal, row by row and issue by issue, the codes in `customFieldRows()`. The duplicate names row 2. 3 created, with typed custom values. Nothing written for invalid rows |
| 3 | Existing leads; duplicate phones and e-mails | Open lead → ATTACHED to it; archived → ATTACHED plus an open ARCHIVED_ENQUIRY case; closed → new lead with `previous_lead_id`. Another org's phone and e-mail → new lead, no case. E-mail cases: with the existing lead (case-insensitive) and between two new rows. **Existing lead rows unchanged in every column.** The owner gets a LEAD_RETURNING_ENQUIRY notification |
| 3 | SKIP policy | 1 skipped, 1 created; no enquiry on the matched lead |
| 4 | Required field added after validation | Commit-time FAILED, `CF_site_city` / `CUSTOM_FIELD_REQUIRED` on every row; 0 leads |
| 5 | Re-upload of the same file | Flagged (`duplicateOfJobId` = first). Confirm without acknowledgement → `RULE_VIOLATION`. With acknowledgement → 0 created, 500 attached, lead count unchanged |
| 6 | Worker killed (SIGKILL) mid-import, 6,000 rows | At the kill: cursor in whole batches, enquiries = cursor (atomic progress). The supervisor restarts the worker and the queue redelivers after the step's lock (≈ 2–3 min). Completion: 6,000 created, 6,000 leads, distinct external ids, 0 duplicate open phones |
| 7 | One import per org | Two concurrent confirmations: exactly one accepted, the other `CONFLICT`. It succeeds after the first completes. 3,050 leads, no duplicates |
| 7 | Two orgs, same 2,000 phones and e-mails at once | Each org gets 2,000 of its own leads and no cross-org case |
| 7 | 40 manual creates racing an import of the same phones | Exactly one lead per phone (lead count = 2,000). The import's attached rows = the creates that won |
| 8 | Round-robin over a 3-member team, 9 rows | 3/3/3 owners, stage ASSIGNED, one open IMPORT spell each, one LEADS_ASSIGNED_DIGEST (count 3) per member |
| 9 | Roles and other orgs | Manager, executive and HR: start → FORBIDDEN, confirm refused. Another org's owner: page 404, confirm NOT_FOUND. The job stays READY with no leads |

### 10.3 `tests/e2e/search-limit.test.ts` (built app, real test Valkey db 1)

**Setup:**
- Three web processes: the main server (3100), a second instance (3101) sharing the Valkey, and an instance whose Valkey is unreachable (3102, `REDIS_URL=redis://127.0.0.1:1/1`).
- Each test deletes its org's key first.
- Waits come from Valkey's clock and the recorded request times, not fixed sleeps.

| Test | Assertions |
|---|---|
| Boundary | 10 searches → 200. The 11th → 429, `Retry-After: 1`, `Cache-Control: private, no-store`, body without org id or query. 10 recorded (refusals not counted) |
| Retry | Refusals while limited do not extend the wait. Once the window frees (Valkey clock) → 200 |
| Concurrency | 25 at once → exactly 10 × 200, 15 × 429 |
| Two processes | 12 searches split over 3100 and 3101 → exactly 10 admitted |
| Cross-org counters | A spent (10); B still gets 10; separate keys hold 10 each |
| RLS | Each org's search shows only its own lead with the shared marker |
| Not metered | 30 requests with filters, sorting, paging and a blank `q` → all 200, no key |
| Signed out | Redirect to sign-in, no key |
| Valkey outage | 503 with `Retry-After: 5` and no-store on 3102. The plain list on 3102 → 200 |

### 10.4 Not written, and known risks

- **The 100k / 20k / re-upload / custom-field corpus checks** stay in the existing harness (`scripts/perf/import-run.mts full`, now with `PERF_COMMIT_STRATEGY`). They are not E2E tests.
- **The proxy has never been built with the search gate.** It loads `@/platform/auth/context` lazily. `pnpm build` is the first check: a build failure there blocks the search-limit E2E.
- **The crash test depends on BullMQ redelivering the stalled step:** `lockDuration` 120 s plus the stalled-job check, about 2–3 minutes; the test allows 7.
- **E2E asserts outcomes, not timing.** NFR-006 timing comes from the corpus harness on `crm_perf` and, finally, from staging.

### 10.5 Commands, in order (PowerShell; each only after checking free memory)

1. **Static and unit (light):**
   - `pnpm exec vitest run --project unit src/env.test.ts src/proxy.test.ts src/platform src/modules/leads src/modules/imports`
2. **Corpus acceptance (≥ 4 GB free; disposable `crm_perf` only):**
   - `node scripts/perf/perf-db.mjs drop; node scripts/perf/perf-db.mjs create`
   - `pnpm exec tsx scripts/perf/seed-perf.mts <scratch>\perf-accounts.json`
   - `$env:PERF_COMMIT_STRATEGY='set'; pnpm exec tsx scripts/perf/import-run.mts <scratch>\perf-accounts.json <scratch>\corpus-set.json full`
   - then drop, create and seed again, and run `node scripts/perf/stage-profile.mjs <scratch>\perf-accounts.json <scratch>\profile-set.json set`
   - finally `node scripts/perf/perf-db.mjs drop`
3. **Build (≥ 6 GB free):** `pnpm build`
4. **E2E acceptance on the set path:** `$env:E2E_IMPORT_COMMIT_STRATEGY='set'; pnpm exec vitest run --project e2e tests/e2e/import-set.test.ts tests/e2e/search-limit.test.ts`
5. **Existing E2E regression on the set path:** `$env:E2E_IMPORT_COMMIT_STRATEGY='set'; pnpm test:e2e`
6. **Default-path regression:** `Remove-Item Env:E2E_IMPORT_COMMIT_STRATEGY; pnpm test:e2e`
7. **Only if 2–6 all pass:** change the application default to `'set'`, rerun the focused suites (step 1, the affected integration files of §8.7, and step 6), and keep `IMPORT_COMMIT_STRATEGY=row` as the documented rollback.

## 11. Acceptance run: lightweight tests pass, the rest blocked by memory (2026-10-26)

**Outcome: step 1 of §10.5 passed. Steps 2–7 were not started (memory). The default is NOT promoted; it is still `'row'`.**

### 11.1 Step 1: lightweight unit tests (run)

`pnpm exec vitest run --project unit src/env.test.ts src/proxy.test.ts src/platform src/modules/leads src/modules/imports`

| Result | Value |
|---|---|
| Test files | **27 passed (27)** |
| Tests | **491 passed (491)** |
| Skipped, todo, failed, unhandled errors | none |
| Duration | 5.46 s (Vitest 5.0.3) |

This covers the new `IMPORT_COMMIT_STRATEGY` validation in `src/env.test.ts` (§10.1). No assertion was changed. **It does not cover the prepared E2E tests**: `tests/e2e/import-set.test.ts` and `tests/e2e/search-limit.test.ts` have still **never run**.

### 11.2 Step 2: memory recheck (after the unit tests)

- **Free memory: 2.45 GB of 15.73 GB.** That is below the 4 GB corpus threshold and the 6 GB build/E2E threshold.
- **Main holders:**
  - Chrome: 5.41 GB across 36 processes;
  - VS Code: 1.48 GB;
  - Claude: 1.04 GB;
  - the Docker/WSL VM: 0.98 GB.
- **Containers in the VM:**
  - this project's `cbr-crm-postgres-1` 235 MB, `cbr-crm-valkey-1` 18 MB, `cbr-crm-mailpit-1` 35 MB;
  - another project's `afx-postgres-dev` 220 MB and `afx-redis-dev` 18 MB.
- **Another project's Node dev servers are running but small:** affex-v2 backend (`nest start --watch`, PIDs 1576 and 20344) and frontend (`next dev`, PID 14064), each under 40 MB.
- **Not stopped or restarted:** no process or container of another project.
- **Not started to check readiness:** no application, worker or extra container.
- **No database operation:** `crm_perf` was not created; `crm_dev` and `crm_test` were not touched.

### 11.3 Status of the §10.5 steps

| Step | Status |
|---|---|
| 1. Static and unit (light) | **Passed**: 27 files, 491 tests |
| 2. Corpus acceptance on `crm_perf` (100k CSV, 20k XLSX, re-upload idempotency, custom fields, 250k throughput) | **Blocked**: memory, 2.45 GB free < 4 GB |
| 3. `pnpm build` | **Blocked**: memory, 2.45 GB free < 6 GB |
| 4. E2E acceptance, set path (`import-set`, `search-limit`) | **Blocked** (needs step 3); never run |
| 5. Full E2E, set path | **Blocked** (needs step 3) |
| 6. Full E2E, default row path | **Blocked** (needs step 3) |
| 7. Promote `'set'` to the default | **Not done**: steps 2–6 have not passed |

**Remaining blocker:** free memory. The largest single holder is Chrome at 5.4 GB. Closing browser windows (and, at the owner's choice, stopping the other project's dev servers and its Docker containers) should free enough for the corpus step, and probably for the build and E2E steps. Per the owner's rule, the resource-intensive steps were not retried under the same conditions.
