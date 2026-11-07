# CBR Property CRM: Phase 2 Implementation Plan (Lead management)

> **Status:** draft for owner review, 2026-10-23. **Scope source:** [phase-roadmap.md §Phase 2](architecture/phase-roadmap.md#phase-2-lead-management); requirements from [functional-requirements.md](product/functional-requirements.md); lifecycle and duplicate rules from [lead-lifecycle.md](product/lead-lifecycle.md); workflows A and G in [workflows.md](product/workflows.md). Nothing here adds scope beyond those documents.
>
> **Objective (roadmap):** get all leads into the system cleanly and owned.
> **Excluded (roadmap):** calling UI, scripts, tasks beyond a next-follow-up placeholder, dashboards.

## 0. Preconditions and open gates

| # | Item | Status | Blocks |
|---|---|---|---|
| P1 | Repository has **no commits**, so a `phase-2-development` branch cannot exist yet. Needs an owner-approved initial commit on `main` (author identity, PHASE-1-REPORT §8) | Open (owner) | All Phase 2 code |
| P2 | Phase 1 exit criteria (roadmap): S1 managed acceptance (S1-08 direct, S1-17, negative control, S1-18), staging over HTTPS, restore drill, cost within OD-15 | **Not met** | Real data, pilot import in staging, Phase 2 exit. Not local development with synthetic data |
| P3 | New tenant tables need new RLS policies, grants and composite FKs (ADR-0004). This is a database-security change and needs explicit owner approval per migration | Open (owner) | M1 onwards |
| P4 | D5 local/managed S3-compatible storage choice | **Decided:** Supabase Storage, private bucket (owner, 2026-10-23); bucket setup is manual ([runbook](runbooks/supabase-storage-setup.md)) | M4 (imports) |
| P5 | OD-05 (sub-status → tags), OD-06 (owner-side enquiries → same Lead), OD-08 (multi-sheet XLSX → choose sheet): defaults proposed | Open (defaults usable) | M1, M4 |
| P6 | Named pilot brokerage, real anonymised import files (OD-14, R-09) | **Open (owner).** The only M4 sign-off blocker. The real-bucket check passed and synthetic fixtures passed (2026-10-24), but neither replaces a real export | M4 corpus, exit |
| P7 | New dependencies (phone metadata, XLSX/CSV parsing, S3 client) need D4-style version approval | Storage client `@supabase/supabase-js@2.118.0` added per the M4 brief; parser pair **approved and installed** (owner, 2026-10-23): `read-excel-file@9.3.12`, `csv-parse@7.0.3` | M4; M0 avoids new dependencies |

## 1. Milestones

| M | Content | Requirements | Depends on | Acceptance |
|---|---|---|---|---|
| **M0** Lead-field normalisation (no DB) | Pure functions for the lead module: phone → E.164 with raw value retained (default region IN), Indian budget parsing ("1.2 Cr", "85 L", "85,00,000"), with machine error codes | FR-043, FR-042 (phone + budget parts) | — | FR-043 examples ("098765 43210", "+91-9876543210", "9876543210" → `+919876543210`); every rejection has a code + message; unit tests only |
| **M1** Lead core | Schema: Lead, LeadSource, LeadEnquiry, LeadNote, LeadStageHistory, LeadActivity, ConsentRecord (model), with RLS forced, composite FKs, crm_app grants. Lead permissions in the catalog (OWN/TEAM/ORG). Manual create with duplicate check (attach enquiry on open-lead match); lead detail with requirements, notes (15-min edit window), stage changes with server-side rules; timeline; audit + outbox events | FR-055, FR-057 (Phase 2 part), FR-058, FR-059, FR-032, FR-170 (model) | M0, P1, P3, P5 | Isolation suite + RLS catalog check cover every new table; permission matrix extended; invalid transitions rejected with reason; duplicate never creates a second open lead (concurrency test) |
| **M2** Lead list | Filters, search (name, phone fragment, email), sort, cursor pagination, scope-filtered | FR-056 | M1 | NFR-001/002 on seeded data; results never exceed the caller's scope |
| **M3** Ownership | Manual/bulk assign, reassign with reason and optimistic lock, immutable assignment history, unassigned queues with age, basic round-robin (concurrency-safe pointer), deactivation handover; in-app notification centre, digests for bulk | FR-070–FR-073 (basic), FR-075, FR-077, FR-063 (assign), FR-118, FR-120 | M1 | Reassignment race test (stale version → conflict); bulk assign sends one digest; deactivation blocked with orphaned open leads |
| **M4** Import | Presigned upload, preview + mapping templates, validation, in-file and existing-lead dedup, background chunks with progress, rejected-rows report, retry-safe resume, content-hash warning, history, cancel, dry run, import-time assignment, uploader attestation (consent) | FR-040–FR-052, FR-170 | M0, M1, M3, P4, P6, P7 | 100k-row import ≤ 10 min with exact counts across forced worker crashes; zero duplicate open leads under concurrent imports; dry run writes nothing |
| **M5** Hygiene | Archive/restore, merge (Should), other bulk actions, custom fields (≤ 30, Should), export job (Should), duplicate review queue | FR-061, FR-062, FR-063 (archive of a selection ≤ 100; by filter and jobs > 500 **deferred** past the pilot, owner 2026-10-26), FR-064, FR-066 | M1–M3 | Merge moves timeline/enquiries and tombstones; export link single-use, 15 min, audited |
| **M6** Exit | k6 on a 250k-lead org; import corpus; pilot org imports real data in staging with consent | Roadmap exit criteria | M1–M5, P2, P6 | As in the roadmap |

**M5 (2026-10-24):** in progress locally (uncommitted).
- **Database:** migration `0006_hygiene` (owner decisions D1–D5, audit fixes F1–F14, amendment A1) is **applied to local `crm_test` only**. `crm_dev` and every managed database are unchanged.
- **Tests:** focused database tests pass (`hygiene-schema` 63/63, `merge-redirect` 6/6), and the full integration suite was rerun. Results are in [PHASE-2-M5-PROPOSAL.md](PHASE-2-M5-PROPOSAL.md) §G.
- **Done in application code:** permissions; pure modules for custom fields, merge planning and merge chains, duplicate review, export format and export job rules; `exports/` storage keys; redirection of notes and enquiries from merged leads.
- **Service layers (2026-10-25):** all four slices are built and tested on `crm_test`: archive/restore with duplicate review, merge, custom fields, and exports (worker, download route, cleanup). Details: [PHASE-2-M5-PROPOSAL.md](PHASE-2-M5-PROPOSAL.md) §E.
- **UI and remaining requirements (2026-10-25):**
  - built: archive/restore, the archive view, bulk archive, the review queue, merge preview, custom-field settings and forms, custom fields in imports, the exports page, email duplicate detection, and export-worker recovery;
  - tests: E2E 80/80, integration 420/420, unit 635/635. Details: [PHASE-2-M5-PROPOSAL.md](PHASE-2-M5-PROPOSAL.md) §H.
- **Real-storage acceptance and real-browser review (2026-10-25):** local `crm_test` with the real private bucket and real Chrome, using a synthetic org pair seeded in `crm_test` with 5 synthetic leads. Details: [PHASE-2-M5-PROPOSAL.md](PHASE-2-M5-PROPOSAL.md) §I.
  - **Export flow passed:** request, worker, object at `orgs/<org>/exports/<job>/<hex>.csv`, one download whose SHA-256 matches the job and the bucket object, then 410 on a second try. Another org, an Admin, a Sales Executive and anonymous users are all refused. Formula neutralisation is intact, and no secrets appear in the browser or the logs.
  - **Cleanup passed:** both objects were deleted by the real worker sweep (crm_cleanup) and recorded in their jobs. The bucket is otherwise unchanged.
- **F1 and UI fixes (2026-10-25, local, fake storage):** details in [PHASE-2-M5-PROPOSAL.md](PHASE-2-M5-PROPOSAL.md) §J.
  - **F1 fixed:**
    - every response of the export download route and the import-problems CSV route is `private, no-store` (shared `privateRoute` / `privateResponse`), as are the proxy's sign-in redirect and framework-generated responses on those paths;
    - verified over real HTTP for 200, 410 (used and expired), 503, 404 (missing, malformed, wrong role, other org), 307 and 401, and in unit tests for an unexpected 500;
    - the shared-browser scenario was replayed in real Chrome: the next user now gets their own 404, not the cached 410.
  - **U1–U9 fixed and verified in real Chrome**, with unit, integration or E2E regressions where the repo can test them. There is no DOM test environment, so client-only behaviour is browser-verified.
  - **Responsive review:** headless installed Chrome at exact 390, 768 and 1280 px viewports (the visible window could not be resized). No page overflow, no clipped actions, tables scroll in their own container, controls are labelled, and focus is visible.
  - **Tests:** unit 662/662, focused integration 98/98, E2E 83/83 (m5-routes 12/12 after the fixes); typecheck, lint and format clean.
- **Final review actions (2026-10-26):** details in [PHASE-2-M5-PROPOSAL.md](PHASE-2-M5-PROPOSAL.md) §K.
  - **FR-063:** owner decision recorded in `functional-requirements.md`. **Partially implemented:** bulk assign and the selection-based, all-or-nothing bulk archive of up to 100 leads. **Archive by filter and jobs above 500 are explicitly deferred** until after the initial pilot (not done).
  - **Duplicate rules:** exact-email review only; phone matching and archived-lead review unchanged; no phone-only or name-only cases. Rules and rationale are in `lead-lifecycle.md` §5.1.
  - **Phone-width fixes:**
    - a "Menu" disclosure lists every destination below 1024 px;
    - a "Lead actions" bar near the top holds Archive/Restore and Merge;
    - targets are at least 44 × 44 px below 1024 px.
  - **Verified:**
    - headless Chrome at 390/768/1280: 0 small targets below 1024 px, every destination reachable, the menu keyboard-operable, no overflow;
    - E2E 83/83, then m5-routes 12/12; unit 669/669, including a route-level test that an unexpected exception gives a generic, private 500.
- **M5 status: SIGNED OFF for the approved scope (owner, 2026-10-26).**
  - **Evidence:** unit 669/669, E2E 83/83, `m5-routes` 12/12, clean typecheck/lint/format; F1 caching fix, U1–U9 and responsive layouts (390/768/1280) verified; real-storage export acceptance passed earlier (§I).
  - **FR-063:** implemented: bulk assign and the all-or-nothing bulk archive of ≤ 100 selected leads. Deferred until after the pilot: archive by filter and jobs above 500. Not implemented: change team, add tag.
  - **Sign-off record:** [PHASE-2-M5-PROPOSAL.md](PHASE-2-M5-PROPOSAL.md) §L.
  - **This is not Phase 2 release acceptance.** M4 is still not signed off (P6).
  - Migration 0006 is applied to `crm_test` only; promotion needs separate approval.

**M6 (2026-10-26): started, preparation only.** Readiness matrix and staging plan: [PHASE-2-M6-READINESS.md](PHASE-2-M6-READINESS.md). Load test: [PHASE-2-M6-LOAD-TEST-PLAN.md](PHASE-2-M6-LOAD-TEST-PLAN.md).

Gate status, each kept separate:
- **P1:** awaiting separate approval (no commit).
- **P2:** not met.
- **P6:** open; synthetic data does not satisfy it.
- **M6-a performance:** not met. Preliminary local results:
  - lists and filters pass;
  - rare-match search exceeded NFR-001 at 3× load in the first run, and text search is now capped at 10/s per organisation;
  - imports run at 49 rows/s on the shipped path (P-A + P-B + P-F) against NFR-006's 300;
  - the unreviewed set-based prototype reached 1,359 rows/s in a local 1,000-row sample.
- **M6-b corpus:** synthetic corpus prepared; real format waits for P6.
- **M6-c pilot import:** blocked.

Done locally (synthetic only):
- **Isolated database:** `crm_perf`, created by the approved drill method and dropped after use.
- **Harness:** a deterministic 250k-lead seed plus benchmark and import scripts under `scripts/perf/`.
- **Corpus:** `pilot/synthetic-corpus/` (5 files incl. 100k rows ≈ 19.95 MB), unit test 7/7.
- **Root causes measured:** under RLS, `LIKE`/`ILIKE`/`citext` predicates cannot use indexes (not leakproof), so the e-mail duplicate check and the returning-customer lookup scan the whole table per imported row.
- **Proposals (owner, 2026-10-26):** P-A to P-D approved for local work; P-E decided (substring semantics kept).
- **Implemented and measured locally (2026-10-26, uncommitted):** details in the [load-test plan](PHASE-2-M6-LOAD-TEST-PLAN.md) §7.
  - P-A and P-C are application changes; P-B and P-D are migrations 0007/0008.
  - Full-phone search p95 369 → 23 ms; name sort p95 126 → 27 ms; per-lead lookups 42–62 ms → < 0.1 ms.
- **Second round (2026-10-26, uncommitted; [load-test plan](PHASE-2-M6-LOAD-TEST-PLAN.md) §8):**
  - **0007/0008 promoted** unchanged and applied to the local `crm_test` and `crm_dev` (0006 first on `crm_dev`), after verified backups. No managed database.
  - **P-F** (open-lead phone match through existing indexes): imports 14 → **49 rows/s**. NFR-006 still fails on the shipped path.
  - **Search limit:** 10 text searches/s per organisation on Valkey. 429 with Retry-After; 503 when the limiter is unavailable (fails closed).
  - **Set-based import commit:** [design](PHASE-2-M6-SET-BASED-IMPORT.md) plus a prototype behind a switch. 1,359 rows/s locally, outcomes identical to the row path in a differential test. Awaiting review; not the default.
  - **Tests:** focused unit 502/502, affected integration 349/349 (Vitest exit 0; the `import-flow` unhandled rejections are fixed).
  - **Not run:** the corpus checks. Free memory stayed below 4 GB.
- **Promotion of the set-based importer** (owner-approved, conditional on local acceptance):
  - **Blocked:** 2.5 GB free against the required ≈ 4 GB (≈ 6 GB for the E2E build), so the corpus and E2E acceptance did not start.
  - **The default stays `'row'`** ([load-test plan](PHASE-2-M6-LOAD-TEST-PLAN.md) §9).
  - **Second attempt:** 3.34 GB free, so it was blocked again. No checks ran.
  - **Acceptance suite prepared, not run** ([load-test plan](PHASE-2-M6-LOAD-TEST-PLAN.md) §10):
    - `tests/e2e/import-set.test.ts` and `tests/e2e/search-limit.test.ts`;
    - the worker switch `IMPORT_COMMIT_STRATEGY` (default `row`).
  - **Acceptance run** ([load-test plan](PHASE-2-M6-LOAD-TEST-PLAN.md) §11):
    - unit 491/491;
    - **corpus PASSED** with `set`: everything reconciled, 1,587–1,896 rows/s, ≈ 106–126 ms per batch;
    - build and E2E **blocked** at 3.93 GB free (needs 6 GB);
    - default still `row`; **M6 not passed**.
  - **Build and E2E acceptance completed** ([load-test plan](PHASE-2-M6-LOAD-TEST-PLAN.md) §12):
    - build passed;
    - new E2E 23/23;
    - full E2E 106/106 on `set` and 106/106 on `row`.
  - **Set-based commit promoted to the default:**
    - rollback `IMPORT_COMMIT_STRATEGY=row`;
    - regression after the change: unit 491/491, integration 165/165, default-path E2E 16/16.
  - **M6 still open:** staging, P2, P6 and M6-c.
- **Initial pilot direction (owner, 2026-10-26):** four companies on **Supabase Free PostgreSQL**; DigitalOcean is not approved.
  - The 250,000-lead staging test is **deferred** to a future scale milestone (not passed).
  - Compatibility prepared and rehearsed locally on PostgreSQL 17: integration 469/469; backup and restore with identical counts.
  - Nothing has run on Supabase yet.
  - Open gates: [readiness §6](PHASE-2-M6-READINESS.md); procedure: [runbook](runbooks/supabase-free-setup.md).

**Phase 2 is not complete.**

**Progress (2026-10-23):** M4 part 1 implemented locally (uncommitted), see [PHASE-2-M4-REPORT.md](PHASE-2-M4-REPORT.md): Supabase Storage gateway (D5/P4 decided: Supabase Storage, private bucket), file checks, mapping, row validation, `lead.import`, and a retry-safe import write path on existing tables. Both M4 approvals given (owner, 2026-10-23): parsers installed and wired (part 2); migration `0005_imports` (with the dedicated `crm_cleanup` role) **applied to local `crm_test` and local `crm_dev`** (crm_dev: 0003–0005 applied 2026-10-23, schema identical to crm_test, role probes 23/23); no managed database. M4 part 3 implemented locally (uncommitted): import jobs, signed upload and verification, worker analysis/validation/dry run/batched import as the uploader with pause and resume, cancel, cleanup sweep, and the full import UI; focused integration 217/217 and e2e 71/71 on `crm_test` (report §Checks run). **M4 is not signed off:** real-bucket acceptance passed over HTTP on 2026-10-24 (probe 18/18, bucket limits 3/3, CSV+XLSX flow, refusals and cleanup 55/55 + 8/8). The real-browser step (§4 step 3) passed the same day with CSV and XLSX. The importer also passed self-generated synthetic pilot fixtures (CSV + XLSX, 29 cases each; one UI-hint defect fixed); this does not satisfy P6. The only outstanding M4 gate is a real brokerage's anonymised export (P6). M0 done. M3 implemented locally (uncommitted): assignment/reassignment, bulk and round-robin assignment, assignment history with the M1 backfill (migration `0004_assignment`), unassigned queue, deactivation handover, in-app notifications and the assigned-date filter. M2 implemented locally (uncommitted): search, filters, sort and cursor pagination on `/app/leads`; the follow-up-due and assigned-date filters of FR-056 wait for tasks (Phase 3) and assignment history (M3). M1 implemented locally (uncommitted): `src/modules/leads`, `/app/leads` pages, migration `0003_leads`. Deferred from M1: ConsentRecord model (moves to M4 with import attestation), lead-source management UI, contact-detail edits, assignment history for creator-assigned leads (M3 must backfill from `created_at`), owner notification on a returning enquiry (M3).

## 2. Key user-facing features

1. Create a lead by hand and be told immediately if the customer already exists (walk-ins, referrals).
2. See every lead you are allowed to see in one fast, filterable list.
3. Open a lead: requirements, notes, stage, full timeline.
4. Assign, reassign and round-robin leads; work the unassigned queue; get notified on assignment.
5. Import portal Excel/CSV exports with mapping, validation, dedup, progress and a fix-and-reupload report.
6. Archive, merge and export leads.

## 3. Security boundaries every milestone keeps

- Every new tenant table: `org_id`, RLS enabled + forced, crm_app tenant policy, composite FKs; covered by the automated RLS catalog check and the isolation suite. Policies are added, never relaxed.
- All access through `withTenant` + `authorize()`/`scopeFor()`; no new database roles; crm_auth gains nothing.
- Every change audited; side effects through the transactional outbox.
- Synthetic data only until P2 is closed.

## 4. First feature: M0 lead-field normalisation

Chosen because it needs no schema, RLS, role, auth or permission change, adds no dependency, and is the foundation for manual create (FR-055), dedup (FR-044/045) and import validation (FR-042).

- **Location:** `src/modules/leads/normalise.ts` (+ `normalise.test.ts`), following the module layout in [module-boundaries.md](architecture/module-boundaries.md).
- **Why not reuse `normalisePhone` in `src/modules/profile`:** it accepts only `+E.164` or a bare 10-digit number, so two of the three FR-043 examples ("098765 43210", "+91-9876543210") are rejected. Profile behaviour stays unchanged; it can adopt the lead normaliser later.
- **Checks:** unit tests for the new file, typecheck, lint. No database or remote tests.
