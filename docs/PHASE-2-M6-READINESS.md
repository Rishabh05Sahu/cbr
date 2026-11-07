# Phase 2 M6 (exit): readiness checklist and staging acceptance plan

> **Status (2026-10-26, second round):** M6 has **started** (preparation and local optimisation only; **M6 has not passed**). NFR-006 fails on the shipped path (49 rows/s) and passes only in a local sample of the unreviewed set-based prototype (1,359 rows/s).
> - **M5:** signed off for its approved scope ([PHASE-2-M5-PROPOSAL.md](PHASE-2-M5-PROPOSAL.md) §L).
> - **Phase 2 is not complete:** none of the exit gates below has passed.
> - **No external dependency is marked complete on the strength of local simulation.**
> - Everything so far is local and synthetic. No hosting, no managed database, no real storage bucket, no commits. The only persistent databases changed are the local `crm_test` and `crm_dev`, by the approved migrations 0006–0008.

## 1. Readiness matrix

Each gate has its own status. A local result never closes a gate that requires staging or real data.

| Gate | What it requires | Status | Evidence so far | Blocks |
|---|---|---|---|---|
| **P1: repository baseline** | An owner-approved initial commit on `main` (author identity per PHASE-1-REPORT §8); branches only after that | **Awaiting separate owner approval.** No commit exists, the owner has not authorised one, and none was made or prepared | `git log` has no commits; every file is untracked | The branch workflow and CI on a remote. Not local work |
| **P2: security and staging** (Phase 1 exit) | ① Managed-database security acceptance: S1-08 direct, S1-17, negative control, S1-18 (PgBouncer + Prisma) on the managed database.<br>② Staging deployed over HTTPS.<br>③ Staging restore drill with **measured** RPO and RTO (4 h target).<br>④ Hosting cost and the ₹15,000/month ceiling verified in the provider panel and approved | **Not met.**<br>① Managed S1 incomplete (Neon triage: C7 not done, no remote rerun).<br>② Not deployed.<br>③ Local only: logical restore PASS, local PITR RPO 10.8 s; managed RPO/RTO **pending**.<br>④ Estimate prepared (A1 ≈ ₹9,805 pre-tax; HA/standby pricing **PENDING** confirmation); spend **not approved** | `docs/NEON-S1-FAILURE-TRIAGE.md`, `docs/architecture/recovery-test-results.md`, `docs/architecture/hosting-cost-estimate.md`, `docs/runbooks/staging-preparation.md` | Real customer data, the pilot import, Phase 2 exit |
| **P6: brokerage import compatibility** (M4 gate) | A representative, **anonymised export from the real pilot brokerage**, validated through the importer | **Open (owner).** No file supplied. Synthetic fixtures and the M6 synthetic corpus do **not** satisfy P6. No brokerage headers have been invented | `pilot/anonymised/` (M4 synthetic fixture), `pilot/synthetic-corpus/` (M6 synthetic corpus), both labelled synthetic | M4 sign-off, the M6 import corpus with real formats, the pilot import |
| **M6-a: 250,000-lead performance** | NFR-001/002 (and NFR-006 for imports) met on a seeded 250k-lead org, measured with k6 against **staging** (testing-strategy) | **Not met.**<br>• **Reads**, measured locally (load-test plan §7): P-A to P-D. Full-phone search 369 → 23 ms p95; name sort 126 → 27 ms p95.<br>• **Imports (NFR-006, 300 rows/s)** (§8):<br>&nbsp;&nbsp;– shipped default path, P-A + P-B + **P-F**: **49 rows/s, FAIL** (was 7 → 14);<br>&nbsp;&nbsp;– **set-based prototype: 1,359 rows/s** in a local 1,000-row sample, about 0.14 s per 200-row batch. Same outcomes as the row path (differential test). Not the default, awaiting design review, not measured on the 100k file or on staging.<br>• **Search:** substring search unchanged (P-E). It is now capped at **10 searches/s per organisation**, enforced across instances on Valkey: 429 with Retry-After, and 503 when the limiter is unavailable (fails closed) (§8.3).<br>• **Migrations** 0007/0008 promoted and applied to the local `crm_test` and `crm_dev` (§8.1). Managed databases come only with staging | [PHASE-2-M6-LOAD-TEST-PLAN.md](PHASE-2-M6-LOAD-TEST-PLAN.md) §7–§8, [PHASE-2-M6-SET-BASED-IMPORT.md](PHASE-2-M6-SET-BASED-IMPORT.md) | Phase 2 exit |
| **M6-b: import corpus and validation** | A representative corpus incl. the real brokerage format; exact counts across forced crashes; zero duplicate open leads under concurrent imports | **Partly prepared.**<br>• The synthetic corpus is generated and checked (unit 7/7).<br>• **Concurrency and crashes on the set path:** opposite-order phone and e-mail races (no deadlock, one lead per phone), a crash with rollback and a retry, all tested (§8.4).<br>• **Not run:** the full local corpus (100k to the end, 20k XLSX, re-upload, custom fields last, 250k comparison). Free memory stayed between 0.3 and 2.9 GB all session, below the required ≈ 4 GB (load-test plan §8.6, §7.7). The earlier partial state was consistent: 0 duplicate open-lead phones.<br>• Real formats wait for P6. The concurrent-import test against staging is still open | `pilot/synthetic-corpus/`, `tests/support/import-corpus.test.ts`, `scripts/perf/import-run.mts`, `tests/integration/import-set-*.test.ts` | Phase 2 exit |
| **M6-c: pilot org imports real data in staging** | Only after P2 **and** P6 pass, with the pilot's documented consent and the owner's authorisation for real-data processing (and legal review G5) | **Blocked** (P2, P6, consent and G5 all open) | — | Phase 2 exit |

## 2. Where the M6 preparation stands (local, synthetic)

- **Isolated load-test database.** `crm_perf` sits in the local Docker Postgres. It was created by `scripts/perf/perf-db.mjs`, using the same method as the approved recovery drill, with every migration in `prisma/migrations` (now 0001–0008), and is dropped after use.
  - The load tests never touch `crm_dev` or `crm_test`. Those two received only the approved migrations, 0006–0008 (§8.1).
  - Experimental indexes were created **only** in `crm_perf` and removed again (verified).
- **Load test:** preliminary results, findings and proposals are in [PHASE-2-M6-LOAD-TEST-PLAN.md](PHASE-2-M6-LOAD-TEST-PLAN.md).
- **Approved optimisations (2026-10-26), local only, uncommitted** (load-test plan §7–§8):
  - P-A to P-D, P-F and the per-organisation search limit are implemented and tested.
  - **Migrations 0007 and 0008** were promoted unchanged to `prisma/migrations/` and applied to the local `crm_test` and `crm_dev` (0006 first on `crm_dev`), after verified `pg_dump` backups. Managed databases are unchanged. No RLS policy, role or grant was changed beyond those approved migrations.
  - The **set-based import commit** is a prototype behind `strategy: 'set'`. The default stays row-by-row. It needs no database change.
  - **Owner decision (2026-10-26):** the set-based importer becomes the default once the local corpus and built-app E2E acceptance pass.
    - The acceptance attempt was **blocked by memory**: 2.5 GB free against the ≈ 4 GB rule, so nothing was started.
    - **Not promoted:** the default is still `'row'`.
    - A second attempt was also blocked: 3.34 GB free against 4 GB (corpus) and 6 GB (E2E). Every acceptance check remains blocked.
    - The checks and resource needs are in load-test plan §9.
    - **The acceptance suite is prepared but not run** (load-test plan §10):
      - built-app E2E for set-based imports and for the search limit;
      - a validated worker switch (`IMPORT_COMMIT_STRATEGY`, selected in E2E by `E2E_IMPORT_COMMIT_STRATEGY=set`).

      None of it has passed yet.
- **Import corpus:** `pilot/synthetic-corpus/` (see its README).

## 3. Staging acceptance plan (for the eventual authorised run)

**Do not start** until all of the following are in place:
- P2 ④ (spend) is approved in writing;
- P6 has been supplied;
- the required access is granted;
- the owner explicitly authorises the staging run.

Each step records evidence in a staging report. A failure stops the run.

| # | Area | Checks | Pass criteria / evidence |
|---|---|---|---|
| 1 | **Costs and spending** | Confirm current prices for the chosen option in the provider panel, including HA/standby eligibility (G1a). Set billing alerts at 80% and 100% of the approved budget | Written owner approval of the monthly amount. Screenshots or exports of the panel prices. Alerts configured |
| 2 | **HTTPS and secrets** | Deploy staging behind TLS (HSTS, CSP as built). Production-equivalent secret store; no secrets in images, logs or the repository; rotate the build-time secrets | TLS grade A/A+. `/.env` and source maps not served. Secret scan clean. Staging uses distinct keys and buckets from production |
| 3 | **Least privilege and tenant isolation** | Provision `crm_migrator`/`crm_app`/`crm_auth`/`crm_platform`/`crm_definer`/`crm_cleanup` (runbook §1). Run S1-08, S1-17, the negative control and S1-18 on the managed database; the real-route isolation suites (G3) against staging | Every binding test passes on the managed database. Role attributes verified (no BYPASSRLS). The app refuses owner/admin DB users |
| 4 | **Authentication** | Sign-up by invitation; 2FA enrolment and enforcement for Owner/Admin; sign-in with TOTP; recovery codes; session revocation on suspension/role change; password reset; rate limits | Each flow passes over HTTPS with synthetic users. A revoked session cannot act. Audit entries present |
| 5 | **Backup and recovery** | Runbook §3: managed PITR restore with the writer-and-fork method (3 runs); full-service RTO drill; nightly off-site dump restore | **Measured** RPO (worst of 3) and RTO ≤ 4 h documented. Restored DB keeps RLS/policies/grants and fails closed |
| 6 | **Private storage, imports, exports, cleanup** | Staging bucket (private, 20 MB limit, two MIME types); M4 §4 probe; import flow; M5 export (single use, checksum, watermark); crm_cleanup sweeps | Probe all PASS. Single-use download and 410 on reuse. Objects removed after their purge time. Unrelated objects untouched |
| 7 | **Load (250,000 leads)** | Seed a synthetic 250k-lead org in staging (`scripts/perf/seed-perf.mts` method). Run k6 at the agreed base workload ([load-test plan](PHASE-2-M6-LOAD-TEST-PLAN.md) §3) for NFR-001/002/006, after the approved performance changes | Thresholds as documented (§3 of the plan), **not changed after the results**. Error rate < 1%. No tenant-isolation failure |
| 8 | **Pilot import, real format** | Validate the actual anonymised brokerage export (P6) through the importer in staging: mapping, counts, problems report | Counts reconcile with the source file. The pilot reviews the mapped output |
| 9 | **Consent and approval** | Documented lawful basis and pilot consent for processing their real data (FR-170 attestation); legal review G5 complete; owner's written authorisation | Signed records filed before any real row is uploaded |
| 10 | **Rollback, incidents, go/no-go** | Rollback plan (app version, migration down-paths or restore), incident contacts and on-call, key-leak runbook, data-deletion path for the pilot's data | Explicit, written **go/no-go decision** by the owner, recorded with the evidence above |

## 4. Exact steps still required before staging and the pilot

1. **Owner:** approve or decline the initial commit (P1). Separate from everything else.
2. **Owner:** confirm HA/standby pricing in the panel and approve the monthly hosting spend (P2 ④, G1/G1a).
3. **Owner and engineering:** P-A to P-F and the search limit are done locally (load-test plan §8). Still open:
   - review the set-based import design ([PHASE-2-M6-SET-BASED-IMPORT.md](PHASE-2-M6-SET-BASED-IMPORT.md)) and approve making it the default;
   - run the full corpus (100k, 20k XLSX, re-upload, custom fields, 250k comparison) with ≈ 4 GB free;
   - e2e through a built server, including the 429 path;
   - promoting 0007/0008 to managed databases, with the staging plan (0007 rewrites `lead`; 0008 `CONCURRENTLY`).
4. **Engineering, after 2:** provision staging over HTTPS (runbook §1, §4); run the managed S1 suite and S1-18 (P2 ①); run the restore drill and measure RPO/RTO (P2 ③).
5. **Owner:** name the pilot brokerage and supply a representative anonymised export (P6); arrange consent and legal review (G5).
6. **Engineering, after 3–5:** staging plan steps 6–8 (storage, load at 250k with k6, pilot-format import).
7. **Owner:** written authorisation for real-data processing, then the staging pilot import (M6-c).
8. **Owner:** go/no-go decision (step 10). Only then can Phase 2 exit be assessed.
