# Phase 3 — NFR-003 local benchmark (interaction / outcome-sheet save)

**Status: LOCAL PRODUCTION-BUILD INDICATION ONLY. NFR-003 is NOT formally accepted.**
Formal acceptance still requires the approved staging/k6 method (M6 plan §3) and business
confirmation of the workload (OD-02). G5 remains OPEN.

Run: 2026-10-29, 19:50–20:23 local time (14:20–14:53 UTC). Harness: `scripts/perf/seed-interactions.mts`,
`scripts/perf/bench-interactions.mts`, plus a scratch browser script for calibration and L4.
Raw results: `results.json`, `ledger.jsonl` (5,626 requests), `l4.json` and per-phase logs in the
session scratchpad (`scratchpad/nfr003/`).

## Conclusion (owner decision, 2026-10-29)

Accepted as a **local performance indication only**, with the read-mix detail-read subtest
explicitly **inconclusive**. It will not be fixed or rerun.

- Save p95 stayed under 500 ms at 0.2, 1, 2 and 5 saves/s in this local environment: 236, 256,
  252 and 314 ms.
- At 10 saves/s, save p95 was 2,069 ms: the single local server saturated.
- In the 2 saves/s + 10 reads/s read-mix test, save p95 was 579 ms, above the 500 ms local target.
  Its detail-read subtest is inconclusive because the harness chose leads outside the reading
  executives' scope (§6). The read-mix test has **not** passed.
- List and search reads, and every save, retry, idempotency and side-effect consistency check,
  passed as reported below.
- These are local indications. They are not formal NFR-003 acceptance, and NFR-003 is not shown
  to be fully satisfied. Formal acceptance still requires staging/k6 validation and OD-02 business
  confirmation.

## 1. Summary

| Workload | Saves/s achieved | Timed saves | Errors | p50 | p95 | p99 | Max | Local diagnostic target (p95 ≤ 500 ms, errors < 1 %) |
|---|---|---|---|---|---|---|---|---|
| Derived per-org baseline | 0.2 | 120 | 0 % | 180 ms | 236 ms | 256 ms* | 267 ms | met |
| Elevated peak proxy | 1 | 300 | 0 % | 202 ms | 256 ms | 271 ms* | 304 ms | met |
| Heavier load | 2 | 300 | 0 % | 198 ms | 252 ms | 286 ms* | 344 ms | met |
| Heavier load | 5 | 300 | 0 % | 228 ms | 314 ms | 377 ms* | 488 ms | met |
| Heavier load | 10 | 600 | 0 % | 1,493 ms | 2,069 ms | 2,179 ms* | 2,272 ms | **not met** (saturated) |
| Read-mix test: 2 saves/s + 10 reads/s | 2 | 300 | 0 % | 280 ms | 579 ms | 1,191 ms* | 1,679 ms | **not met** |

L3 latency, timed from each request's *scheduled* send time (open loop, no coordinated omission),
until the full response, including the re-rendered lead page, was read. \* p99 is indicative:
fewer than 1,000 samples.

- Retry and idempotency checks: **all passed.** No duplicate interactions, timeline rows,
  follow-ups, stage changes, requirement changes, contact-status events or audit rows (§5).
- Ledger verification: **PASS.** 5,406 distinct saves = 5,406 rows; every row has a fingerprint.
- The read-mix 2 saves/s + 10 reads/s is a stress mix. It is **not** the confirmed base workload.
- Detail-page reads in the read-mix test are **inconclusive** because of a harness workload flaw
  (§6). List and search reads are valid.

## 2. Environment

- Laptop: Intel i7-1255U (10 cores / 12 threads), 16 GB RAM, Windows 11. One process each for the
  app, Postgres and the load generator, all on the same machine, so they compete for CPU.
- App: production build (`next build`, standalone output, Next.js 16.4.2, Node 24.20.0), one
  server process on `127.0.0.1:3200`.
- Server environment: explicit allow-list. All database URLs point to `127.0.0.1:55432/crm_perf`
  (roles `crm_app`, `crm_auth`, `crm_platform`); Redis is local DB 3. Supabase URL and key are
  blank. `SUPABASE_IMPORT_BUCKET` and `IMPORT_MAX_BYTES` are set to the `src/env.ts` defaults.
  `.env` was not modified.
- Database: PostgreSQL 18.6 in the local Docker Compose container (Docker VM: 12 CPUs, 7.6 GB).
  Isolated database `crm_perf`, migrations 0001–0018, synthetic data only.
- Traffic: every request went to `127.0.0.1` (browser host list and server log checked).

## 3. Data and pools

`seed-perf.mts`, then `seed-interactions.mts`, on a fresh `crm_perf`:

- 255,000 leads (PerfA 250,000; PerfB 5,000), 261,000 activities, 236,674 assignments; 40
  synthetic executives in 4 teams.
- 51,700 earlier interactions with timeline rows: 50,000 history rows, plus 100 on each of the 17
  live heavy-timeline leads (300 extra activities each).
- 1,300 open follow-ups, one per S3 lead.
- Pools (each lead used once across all phases):

  | Pool | Leads | Scenario |
  |---|---|---|
  | S1 | 3,000 | "No answer": no side effects beyond the row and its timeline entry |
  | S2 | 2,600 | first connected outcome on an Assigned lead: moves to Contacted, sets `first_contacted_at`, adds a next follow-up |
  | S3 | 1,300 | full sheet: completes the open follow-up, schedules the next one, patches two requirement fields |
  | S4 | 1,000 | wrong number: confirmed contact-status change to INVALID |
  | S5 | 17 | heavy timeline: "No answer" on leads with long timelines |

- The database had 51,725 interactions before the phases ran: the 51,700 seeded plus 25 synthetic
  calibration saves. All 25 are on one calibration lead outside the ranges the phases use.

## 4. Results by level

### L2 / L1 in-process (diagnostic): `logInteraction()` and its tenant transaction

10 warm-up + 200 timed saves per scenario, sequential, 0 errors. L1 is within 0.5 ms of L2, so
nearly all in-process time is the single tenant transaction.

| Scenario | p50 | p95 | p99* | Max |
|---|---|---|---|---|
| S1 no answer | 20.3 ms | 43.2 ms | 53.1 ms | 71.6 ms |
| S2 first connected | 38.1 ms | 54.3 ms | 64.6 ms | 69.3 ms |
| S3 full sheet | 54.4 ms | 103.1 ms | 144.3 ms | 151.9 ms |
| S4 wrong number | 40.4 ms | 57.0 ms | 64.5 ms | 81.6 ms |
| S5 heavy timeline | 17.5 ms | 26.9 ms | 33.1 ms | 33.6 ms |

### L3 over HTTP, sequential (primary level; one request at a time)

The server action is sent as the browser sends it (`Next-Action` header, captured router-state
header). Timing ends when the full response is read, including the re-rendered lead page. 0 errors
in every scenario; every response contained the re-rendered page.

| Scenario | Timed | p50 | p95 | p99 | Max | Mean response |
|---|---|---|---|---|---|---|
| S1 | 200 | 164 ms | 228 ms | 319 ms* | 388 ms | 38 KB |
| S2 | 1,000 | 171 ms | 223 ms | 273 ms | 465 ms | 38 KB |
| S3 | 200 | 188 ms | 249 ms | 293 ms* | 323 ms | 39 KB |
| S4 | 200 | 168 ms | 225 ms | 271 ms* | 275 ms | 39 KB |
| S5 | 200 | 201 ms | 260 ms | 307 ms* | 313 ms | 144 KB |
| S6: 5 concurrent saves on one lead (×20 rounds) | 100 | 283 ms | 332 ms | 386 ms* | 400 ms | — |

S2 is the only scenario with at least 1,000 samples, so its p99 is reported, not indicative.

### L3 under open-loop load (primary)

Mix: S1 40 % / S2 30 % / S3 20 % / S4 10 %. 5 s client timeout, with one same-key retry after a
timeout. No timeouts or retries occurred. "From scheduled" includes any queueing; "service" is
send-to-response.

| Rate | Warm-up + timed | Achieved | Timed saves | Errors | From scheduled: p50 / p95 / p99* / max | Service: p50 / p95 |
|---|---|---|---|---|---|---|
| 0.2/s | 30 s + 600 s | 0.2/s | 120 | 0 | 180 / 236 / 256 / 267 ms | 171 / 225 ms |
| 1/s | 15 s + 300 s | 1/s | 300 | 0 | 202 / 256 / 271 / 304 ms | 193 / 249 ms |
| 2/s | 15 s + 150 s | 2/s | 300 | 0 | 198 / 252 / 286 / 344 ms | 192 / 246 ms |
| 5/s | 15 s + 60 s | 5/s | 300 | 0 | 228 / 314 / 377 / 488 ms | 219 / 306 ms |
| 10/s | 15 s + 60 s | 10/s | 600 | 0 | 1,493 / 2,069 / 2,179 / 2,272 ms | 1,489 / 2,064 ms |

At 10 saves/s the single local server saturates: latency rises about sevenfold, but there are
still no errors. Postgres CPU peaked at about 167 % in that step, and machine CPU at 55 %.

### Read-mix test: 2 saves/s + 10 reads/s (15 s + 150 s)

| Traffic | Timed | Errors | p50 | p95 | p99* | Max |
|---|---|---|---|---|---|---|
| Saves (2/s achieved) | 300 | 0 | 280 ms | 579 ms | 1,191 ms | 1,679 ms |
| List reads (60 %) | 900 | 0 | 91 ms | 201 ms | 415 ms | 955 ms |
| Search reads (25 %) | 375 | 0 | 108 ms | 263 ms | 477 ms | 753 ms |
| Detail reads (15 %) | 225 | 221 refused (see §6) | n = 4: inconclusive | | | |

Readers: the synthetic manager and 4 executives. With 10 reads/s added, save p95 rose from 252 ms
(2 saves/s alone) to 579 ms.

### L4 browser (diagnostic only; not an NFR-003 result)

Headless Chrome, 390×844, on the production server. Timed from clicking **Save interaction**
until "Interaction saved." shows with a new form key. 1 warm-up + 20 timed saves on one lead:
**p50 248 ms, p95 281 ms (indicative), max 344 ms.**

## 5. Duplicate and side-effect checks

| Check | Result |
|---|---|
| 100 sequential identical retries (S1/S2) | 100/100: same interaction id, answered as duplicate, all side-effect counts unchanged (interaction, activity, stage history, task, contact-status event, audit, lead version) |
| 50 rounds of 3 concurrent identical submissions (S2) | 50/50: exactly one first save and two duplicates; 1 interaction, 1 first-connected stage change and 1 open follow-up per lead |
| 20 changed retries (same key, different outcome) | 20/20 refused as CONFLICT; side-effect counts unchanged |
| Ledger verify (all phases, 5,626 requests) | PASS: 5,406 distinct keys = 5,406 rows; 200 duplicates answered; 20 CONFLICT refusals; no key saved twice; no row without a reported save; every row fingerprinted; timeline rows = interactions |
| S2 leads (2,007) | each Contacted, with `first_contacted_at` and exactly one FIRST_CONNECTED_INTERACTION stage change |
| S3 leads (865) | each with 1 done and 1 open follow-up, `intent` WARM, city Pune, at most one FIELD_CHANGED |
| S4 leads (641) | each INVALID, with exactly one contact-status event |
| S1/S6 leads (1,385) | no stage change |
| Database totals after the run | 57,131 interactions = 51,725 + 5,406; 57,131 timeline rows; 0 without a fingerprint; 0 duplicate keys; 2,007 first-connected changes; 641 contact-status events; 865 done and 3,307 open follow-ups (1,300 − 865 + 865 + 2,007) |

## 6. Inconclusive and limitations

- **Detail reads in the read-mix test are inconclusive.** The harness sends every detail read
  through executive readers 2–4, never the manager, and to leads chosen without regard to owner.
  An executive correctly gets 404 for another executive's lead (checked live: 404 for another's,
  200 for their own). That accounts for exactly 221 refusals and 4 successes. This is a harness
  workload flaw, not a product fault. Fix before any rerun: send detail reads for leads within
  the reader's scope.
- p99 is indicative wherever there are fewer than 1,000 samples, which is every row except
  HTTP S2.
- The 0.2/s baseline has 120 timed samples over 10 minutes. That is enough for p95 but not p99.
- One laptop runs the server, Postgres and the load generator, so they compete for resources.
  Staging hardware, network latency and connection pooling will differ.
- Only one server process; no horizontal scaling.
- Free memory during the run was 2,824–4,379 MB, never below the 1,500 MB floor. Server RSS was
  376–768 MB, and Postgres memory 491–628 MiB.
- Postgres logged a deprecation warning (`client.query()` while a query is executing) during
  saves. It caused no errors, but the cause is not traced.

## 7. Harness corrections made during this run (benchmark code only; no product change)

1. Heavy-lead history and the S5 pool now exclude archived, deleted and merged leads. The guard
   trigger rightly refused interactions on an archived lead.
2. The server and the in-process environment set `SUPABASE_IMPORT_BUCKET` and `IMPORT_MAX_BYTES`
   to the `src/env.ts` defaults. Those keys reject a blank value.
3. Benchmark HTTP sessions set the active organisation (`/api/auth/organization/set-active`), as
   the e2e tests do.
4. `tests/e2e/http.ts` gets a CommonJS `require` when loaded from the ESM harness.
5. Browser calibration sets the active organisation from inside the page, because the production
   cookie is `__Secure-` and must be sent by the page. It also polls from Node instead of using
   `waitForFunction`, because the production CSP correctly disallows `unsafe-eval`.

## 8. Cleanup state

- The benchmark server is stopped by its recorded PID, and port 3200 is closed.
- With the owner's authorisation after accepting the result, `crm_perf` was dropped through
  `scripts/perf/perf-db.mjs`. That drop removes only `crm_perf`; the other local databases were
  not touched.
- The development services stopped for this benchmark were restarted afterwards, once free memory
  allowed.
- Logs, `results.json`, `ledger.jsonl`, `l4.json` and the diagnostic summaries are kept in the
  session scratchpad (`scratchpad/nfr003/`).
