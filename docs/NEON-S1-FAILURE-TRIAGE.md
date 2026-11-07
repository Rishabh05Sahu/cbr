# Neon S1 failure triage

> **Status (updated 2026-10-21, after owner approval of changes 1–4):**
> - **Implemented and checked locally:** C1, C2 (with the safeguards below), C3, C4, C5 and C6. C7 is not done.
> - **Not done:** no cleanup and no remote run. The Neon results below are unchanged.
> - **C2 safeguards:**
>   - the override is accepted only through `neon-s1.mjs --diagnostic-tx-max-wait-ms`, after control-plane and server verification of a non-production Neon branch;
>   - only the batches `s1-08`, `pooled-s1-08` and `db-roles` may be selected;
>   - the S1-08 test re-checks the endpoint host and the server branch;
>   - the run is labelled diagnostic and non-binding in the run directory, the test name, `state.json` and the report;
>   - `src/platform/db/client.ts` is untouched.
>
> Original status: diagnosis only. No fixes are implemented and no tests were re-run.
> - Prepared 2026-10-21 by static inspection of the completed Neon run and the source code. There was no connection to Neon and no database change.
> - **S1 is not passed on Neon.** The DigitalOcean-specific validation (S1-18 on BLR1) is still **pending**.
> - Nothing here waives a failure, relaxes the S1-17 500 ms limit, or changes the S1-08 workload (50 workers × 1,000 iterations over a pool of 5).

## Evidence used

| Item | Location |
|---|---|
| Run directory (Git-ignored) | `spikes/results/managed-runs/neon-2026-10-21T10-29-26-471Z/` |
| Report | `…/report.md`, `…/report.json` |
| Per-test checkpoints | `…/tests.jsonl` |
| Scrubbed output | `…/run.log` |
| Steps, batches, server timing, final verification | `…/state.json` |
| Target | Neon project `odd-bar-00712986`, branch `cbr-s1-test` (`br-spring-bird-b4b3tead`), endpoint `ep-square-hat-b4ud698t`, aws-us-east-2, PostgreSQL 18.6 |
| Measured round trip (test machine → endpoint) | p50 **250 ms**, max 253.2 ms (`run.log`, "round-trip time" step) |
| Software | Prisma 7.10.1, `@prisma/adapter-pg` 7.10.1, `pg` 8.23.1, Vitest 5.0.3 (`package.json`) |

`docs/NEON-S1-TEST-REPORT.md` has not been written yet. It should follow the decisions on this triage.

**Result:**
- 160 passed, 8 failed, 0 blocked, 0 not run.
- Checks 5/5 passed.
- The run is complete but not all tests passed.

## Summary

| # | Failure | Likely cause | Confidence | Security defect shown? |
|---|---|---|---|---|
| 1 | `s1-08`: S1-08 "50 workers x 1000 iterations over a pool of 5: 0 leaks" (direct) | Prisma's 30 s `maxWait` for **starting** a transaction was exceeded. With 50 workers queued on 5 connections and about 1.25 s per transaction (5 round trips × 250 ms), the mean wait is already about 11 s. A transient slowdown pushed one wait past 30 s | High that it is a start-wait timeout; **low** on what caused the slowdown | **No evidence either way.** The test aborted before any leak assertion ran |
| 2 | `pooled-s1-08`: same test through the Neon pooler | Same mechanism, earlier (after 630 s) | High on the mechanism; low on the trigger | Same: not assessed |
| 3–5 | `db-roles`: "crm_app / crm_auth / crm_platform hardening > cannot SET ROLE postgres" | The test names a role that does not exist on Neon. The error was `role "postgres" does not exist`, not `permission denied` | High | **No.** The test correctly refused to count a missing role as a denial. The real privileged roles were not tested behaviourally |
| 6–8 | `s1-17`: "end-to-end list …, Sales Executive (OWN) / Sales Manager (TEAM) / Admin (ORG): p95 <= 500 ms" | Network round trips. Each list makes 5–9 **sequential** round trips at about 250 ms each, so the floor is 1.25–2.25 s before any database work | High | No. The server-side query time is about 0.05–0.14 ms |

**No security defect was demonstrated.** Elsewhere, two test-coverage gaps, one loose verification rule and two documentation gaps were found (§4, §5).

---

## 1. S1-08 direct and S1-08 pooled: "Unable to start a transaction in the given time"

### 1a. Evidence

| | Direct (`s1-08`) | Pooled (`pooled-s1-08`) |
|---|---|---|
| Test | `spikes/s1-tenant-isolation/tests/s1-08-concurrency.test.ts`, "S1-08 pool leakage under concurrency > 50 workers x 1000 iterations over a pool of 5: 0 leaks" | same file, `S1_APP_URL` pointed at the pooler host |
| Started → failed | 10:32:18Z → 11:50:03Z | 12:19:06Z → 12:30:11Z |
| Test duration at failure | **4,630.7 s** (77 min) | **630.1 s** (10.5 min) |
| Error | `PrismaClientKnownRequestError: Transaction API error: Unable to start a transaction in the given time.` raised at `worker` (`s1-08-concurrency.test.ts:50`, the `withTenant` call) | identical |
| Wall-clock test limit | 28,800,000 ms (`S1_LONG_TEST_TIMEOUT_MS`), not reached | not reached |

**What the error means.** The check is in `node_modules/.pnpm/@prisma+client@7.10.1…/node_modules/@prisma/client/runtime/client.js`, in the TransactionManager start path.
- Prisma starts a `setTimeout(abort, maxWait)` timer and races it against `driverAdapter.startTransaction()`.
- If the timer fires first, it throws this error (`TransactionStartTimeoutError`). It then waits for the late start to finish and closes it with status `timed_out`, so the connection is returned to the pool.
- In `@prisma/adapter-pg` 7.10.1 (`dist/index.js`, `startTransaction`), `startTransaction` is `await pool.connect()` followed by `BEGIN`.

**So the 30 s budget covers two things:**
- the wait in the `pg.Pool` queue for one of the 5 connections;
- one `BEGIN` round trip.

**Relevant configuration:**

| Setting | Value | Location |
|---|---|---|
| Prisma `maxWait` / `timeout` for the spike runner | 30,000 / 30,000 ms | `spikes/s1-tenant-isolation/db/clients.ts`, `tenantRunnerFor()` |
| `pg.Pool` size for the S1-08 app client | 5 (`POOL`) | `s1-08-concurrency.test.ts`; `createAppClient(POOL)` |
| `pg.Pool` `connectionTimeoutMillis` | 120,000 ms in this run. This is longer than `maxWait`, so Prisma's timer always fires first | `db/clients.ts`; set by `scripts/managed-db/neon-s1.mjs` (`S1_CONNECTION_TIMEOUT_MS`) |
| Production runner (for comparison, unchanged) | `maxWait` 10,000, `timeout` 15,000 | `src/platform/db/client.ts`, `tenantRunner()` |
| Context mechanism | interactive transaction + `set_config(..., true)` | `src/platform/db/with-tenant.ts` |

### 1b. Cause

**Queueing model.**

Each `withTenant` transaction in S1-08 holds a connection for **5 sequential round trips**:
1. `BEGIN`;
2. `set_config`;
3. the `current_setting`/`pg_backend_pid` probe;
4. `lead.findMany`;
5. `COMMIT` or `ROLLBACK`.

At about 250 ms per round trip, that is about 1.25 s per transaction. Every 20th iteration also runs an unwrapped `lead.count()`, which takes one round trip on the same pool.

This is a closed system: 50 workers, 5 connections, and the FIFO `pg.Pool` queue.

| | Local (S1 report: 50,000 tx in ~124 s) | Neon from this machine |
|---|---|---|
| Connection hold per transaction | ~12 ms | ~1,250 ms |
| Throughput (5 connections) | ~400 tx/s | ~4 tx/s |
| Mean start wait ≈ (50 − 5) / 5 × hold | ~0.1 s | **~11 s** |
| Headroom against `maxWait` 30 s | ~270× | **~2.7×** |
| Expected duration of all 50,000 tx | ~2 min | **~3.5 h** |

**What tripped the timeout.** One transaction failed because its start wait exceeded 30 s. In steady state the waits are about 11 s with little spread, because the queue is FIFO. The timeout therefore needs throughput to fall to roughly **a third of normal for about 20 s or more**.

Candidates, none of which can be distinguished from the recorded evidence:
- TCP retransmission stalls on one or more of the 5 long-haul connections;
- a hiccup in the Neon proxy or pooler;
- a pause in Neon compute;
- a slow connection leak in the client pool on an error path.

The leak candidate is not seen locally: 3/3 local runs and both direct and pooled S1-07 passed here. The test logs no progress, pool counters or wait times, so nothing in the run identifies the trigger.

**Ruled in or out:**

| Hypothesis | Assessment |
|---|---|
| **Prisma transaction-start (`maxWait`) timeout** | **Confirmed.** It is the exact error class, raised at `withTenant` |
| Interactive transaction `timeout` (30 s from start to commit) | Ruled out. That gives a different error ("…expired transaction…" / "Transaction already closed"), and nothing like it appears in `run.log` |
| `pg.Pool` connect timeout | Ruled out as the first cause: it is 120 s, longer than `maxWait` |
| **Client pool saturation (by design: 50 workers on 5 connections)** | **Contributing, by design.** It amplifies network latency into an ~11 s queue. This is the test's intended stress, not a defect |
| Database connection limits | Very unlikely. `max_connections` is 901 (recorded during preparation) against ≤ 10 test connections, and a refusal would give a connection error, not a start-wait timeout |
| Server-side timeouts (`statement_timeout` 10 s, `idle_in_transaction_session_timeout` 30 s on `crm_app`, from `scripts/db/bootstrap-managed-roles.sql`) | Unlikely. Either would end the session with a server error, and none was logged |
| Neon pooler limits (pooled run only) | Not determined. Neon documents a large server-side pool and client limit, but this run did not verify them. The pooled failure came earlier (630 s), and two samples cannot tell a pooler effect from chance |
| Prisma or adapter defect | No evidence. The timeout path closes the late transaction, so it does not leak connections. A slow pool leak on a WAN error path cannot be excluded without pool counters (see 1d) |

**Confidence:**
- High that this is a latency-amplified start-wait timeout;
- low on what caused the stall.

### 1c. Did the zero-leak assertion run? **No.**

The `expect(...)` calls and the `[S1-08] …` summary line come after `await Promise.all(workers)` (`s1-08-concurrency.test.ts`, lines 82–95). The first non-`Planned` error rejects `Promise.all`, so:
- **no assertion was evaluated**:
  - `leakSamples` empty;
  - `leaks === 0`;
  - 50,000 transactions completed;
  - `pids.size <= 5`;
- **the leak counters were never printed.** The per-iteration checks for the completed iterations did run, but they only increment `leaks` and do not throw, so their outcome is **unknown**;
- the remaining workers kept running until `afterAll` closed the pool.

**How far the runs got (estimate only, no logged progress):**
- direct: about 18,000 of 50,000 transactions (~37%);
- pooled: about 2,500 (~5%).

**Result:** S1-08 is **failed / not assessed** on Neon. It is not passed, and it is not evidence of a leak. The partial support from S1-07 (context cleared on the same pooled connection after commit and after rollback: passed directly and through the pooler) does **not** replace S1-08.

**Separate risk for the pooled variant.** `expect(pids.size).toBeLessThanOrEqual(POOL)` assumes at most 5 server backends. Through PgBouncer in transaction mode, `pg_backend_pid()` is whichever server connection PgBouncer picks. Neon's server-side pool size is not set by us, so this assertion may fail on Neon for a reason unrelated to tenant leakage, even if the timeout is fixed. On DigitalOcean the runbook sets the pool size to 5 (`docs/runbooks/staging-preparation.md` §1.2), so the assertion is meaningful there. **Do not relax it.** If it fails on Neon's pooler, record it as provider-specific and assess it on DigitalOcean.

### 1d. Smallest safe changes (proposed, not implemented)

1. **Instrumentation only, no assertion change** (`s1-08-concurrency.test.ts`):
   - wrap `await Promise.all(...)` in `try/finally` so the counters line **and** `leakSamples` are printed even when a worker throws;
   - every 60 s, print progress to stdout: committed, rolledBack, probes, leaks, distinct pids, `app.pool.totalCount`/`idleCount`/`waitingCount`, and the slowest `withTenant` start wait so far.

   With this, a failure shows how far the run got, whether any leak had been seen, and whether the pool shrank (leak) or stalled (network).
2. **A spike-only override of the transaction-start budget, for the WAN diagnostic only** (`db/clients.ts`, `tenantRunnerFor()`):
   - change: `maxWait: Number(process.env.S1_TX_MAX_WAIT_MS ?? 30_000)`. The default and the local behaviour stay the same;
   - what does not change: the workload, the pool of 5, the isolation checks and `timeout`;
   - **needs your explicit approval.** `maxWait` is an existing time limit, even though it limits client queueing rather than isolation;
   - **any result produced with it must be labelled as a deviation**: "S1-08 on Neon with `maxWait` raised to N s for 250 ms WAN latency";
   - `src/platform/db/client.ts` is not touched.
3. If you do not approve change 2: rerun with change 1 only, to capture the stall. Expect a likely repeat failure and up to about 3.5 h per variant.

**Preferred binding evidence:** S1-08 with the **unchanged 30 s `maxWait`**, from a machine in the same region as the database. On DigitalOcean BLR1, the same-region round trip is about 1 ms, so the wait is far below the limit.

### 1e. Targeted rerun (only after approval and a local check of the change)

- **Local check first.** This uses the local database only, not Neon:
  ```powershell
  pnpm vitest run --project s1 spikes/s1-tenant-isolation/tests/s1-08-concurrency.test.ts
  ```
- **The runner does not re-run batches already marked done.** A targeted rerun is therefore a **new fresh run** with only the needed batches. The existing run directory stays as evidence.
- **The clean-up step drops the test databases and the 5 `crm_*` roles on `cbr-s1-test` only, and needs your approval:**
  ```powershell
  cd C:\Users\aDMIN\Desktop\CRM
  $env:NEON_CLI = 'C:\Users\aDMIN\AppData\Local\npm-cache\_npx\7f657307477966ff\node_modules\.bin\neon.cmd'
  $env:NODE_NO_WARNINGS = '1'
  node scripts/managed-db/neon-clean.mjs --branch-id br-spring-bird-b4b3tead --dry-run
  node scripts/managed-db/neon-clean.mjs --branch-id br-spring-bird-b4b3tead
  # as implemented (change 2): the override is a flag, never an environment variable
  node scripts/managed-db/neon-s1.mjs --branch-id br-spring-bird-b4b3tead --batches s1-08,pooled-s1-08,db-roles --diagnostic-tx-max-wait-ms 300000
  ```
- **Expected duration:** about 3.5 h per S1-08 variant. Run it from your own PowerShell window, as before.
- `db-roles` is included only once the §2 test change exists. Without it the same 3 failures repeat.

---

## 2. db-roles: "cannot SET ROLE postgres" (crm_app, crm_auth, crm_platform)

### 2a. Evidence

- **Test:** `tests/integration/db-roles.test.ts`, lines 91–97:
  ```ts
  it.each(['crm_migrator', 'crm_definer', 'crm_app', 'crm_auth', 'postgres'].filter((r) => r !== role))
    ('cannot SET ROLE %s', … rejects.toThrow(/permission denied/))
  ```
- **The 3 failures:** `expected [Function] to throw error matching /permission denied/ but got 'role "postgres" does not exist'`.
- **Passed in the same file (37 tests):**
  - for each of the 3 roles, "is not superuser, cannot bypass RLS, create roles/DBs, or inherit other roles". This asserts `rolsuper`, `rolbypassrls`, `rolcreaterole` and `rolcreatedb` are all false, **`memberships = 0`** (the role is a member of no role) and `owned = 0`;
  - every SET ROLE check against an existing `crm_*` role;
  - "cannot create objects or disable RLS";
  - D2 least privilege;
  - credential/session denials;
  - platform PII denials;
  - RLS coverage.

**Neon's role model.** Recorded during preparation on 2026-10-21; not re-queried in this triage.
- **`neondb_owner`** (the provider admin used for bootstrap):
  - NOSUPERUSER, with CREATEROLE, CREATEDB, REPLICATION and **BYPASSRLS**;
  - a member of **`neon_superuser`**, which carries `pg_read_all_data`, `pg_write_all_data` and `pg_signal_backend`, granted by `cloud_admin`.
- There is **no `postgres` role** on the branch.

### 2b. Cause and security impact

The test hard-codes the **local** superuser's name.
- On Neon the target does not exist, so the check proves nothing. It **correctly failed** rather than counting "does not exist" as "denied". Keep that behaviour.
- The roles that are actually privileged on Neon (`neondb_owner`, `neon_superuser`, `cloud_admin`) and the dangerous predefined roles were **not** tested behaviourally.

**Is an escalation path shown? No.** PostgreSQL lets `SET ROLE r` succeed only for a superuser or for a member of `r` with the SET option. The passing structural check shows each app role is non-superuser and **a member of no role at all**. That is provider-independent proof that none of them can SET ROLE to any role. So these 3 failures are a **provider-incompatible test assumption, not a security defect**. The behavioural check against a real privileged role is still missing and should be restored, not skipped.

**Coverage gap found during review.** `crm_platform` is never a SET ROLE target for `crm_app` or `crm_auth`: the list has no `crm_platform`. The `memberships = 0` check covers it structurally, but the behavioural list is incomplete.

### 2c. Minimum test change (proposed, not implemented)

**In `tests/integration/db-roles.test.ts`, replace the hard-coded `'postgres'` with targets taken from the catalog.**
- **Universal**, valid on any provider; this list is never empty:
  - every `crm_*` role other than the role under test, **adding `crm_platform`**;
  - **every existing privileged role**, discovered with a query along the lines of:
    ```sql
    SELECT rolname FROM pg_roles
    WHERE rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication
       OR rolname IN ('pg_read_all_data','pg_write_all_data','pg_signal_backend',
                      'pg_read_server_files','pg_write_server_files','pg_execute_server_program')
       OR oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
    ```
- **Assertions:**
  - each discovered role must be rejected with `/permission denied/`;
  - `pg_has_role(current_user, r, 'MEMBER')` must be false for each;
  - **the discovered set must be non-empty and must include the known provider admin.**
- **Provider-specific** (named, existence asserted, so a missing role fails instead of passing):
  - a `TEST_PROVIDER_PRIVILEGED_ROLES` list: `postgres` locally, `neondb_owner,neon_superuser` on Neon, `doadmin` on DigitalOcean;
  - set by `scripts/managed-db/s1-managed-run.mjs` from the admin user name, plus the local default.
- **Unchanged:** the `/permission denied/` match, and the `memberships = 0` and attribute assertions.

**Which checks stay universal and which are provider-specific:**

| Universal (all environments) | Provider-specific |
|---|---|
| No `rolsuper`, `rolbypassrls`, `rolcreaterole` or `rolcreatedb` on `crm_app`/`crm_auth`/`crm_platform` | The **names** of the admin/superuser roles (`postgres`, `neondb_owner`/`neon_superuser`/`cloud_admin`, `doadmin`) |
| App roles are members of no role | Whether the admin holds an ADMIN-only creator membership in the `crm_*` roles (PostgreSQL 16+ when the admin is not a superuser; see §4) |
| SET ROLE denied to every other `crm_*` role and to every privileged role found in the catalog | Whether the pooled path exposes server pids ≤ the pool size (§1c) |
| Cannot create objects or disable RLS; forced RLS on every org table; least-privilege grants | |

---

## 3. S1-17: end-to-end list p95 > 500 ms (OWN, TEAM, ORG)

### 3a. Evidence

Test: `spikes/s1-tenant-isolation/tests/s1-17-performance.test.ts`, lines 131–150. It runs 20 warm-up + 200 runs of `withTenant(... listLeads ...)` (`spikes/s1-tenant-isolation/harness/lead-repository.ts`), measured from the test machine. The 500 ms limit is unchanged.

| Test | p50 | p95 | max | Local p95 (S1 report, 3 runs) |
|---|---|---|---|---|
| Sales Executive (OWN) | 1,539.85 ms | **1,549.27 ms** | 1,789.75 ms | 11.5–29.8 ms |
| Sales Manager (TEAM) | 2,377.58 ms | **2,402.81 ms** | 2,858.31 ms | 25.8–27.9 ms |
| Admin (ORG) | 1,323.20 ms | **1,335.13 ms** | 1,541.32 ms | 11.1–16.5 ms |

### 3b. Reconciling with the 250 ms round trip

Each request makes sequential round trips that cannot overlap: `BEGIN`, `set_config`, the scope queries in `leadScopeWhere`, `lead.findMany`, and `COMMIT`.

| Scope | Sequential round trips | × 250 ms | Measured p50 | Residual (client + server + proxy) |
|---|---|---|---|---|
| ORG | 5 (BEGIN, set_config, membership, findMany, COMMIT) | 1,250 ms | 1,323 ms | ~73 ms |
| OWN | 6 (+ delegations) | 1,500 ms | 1,540 ms | ~40 ms |
| TEAM | 9 (+ delegations, led teams, team members) | 2,250 ms | 2,378 ms | ~128 ms |

- The counts are inferred from the code path. They match all three measurements, and the residuals are within the error of a 250 ms round-trip estimate.
- The latency is therefore **network round trips**, not database or RLS work.
- **To meet 500 ms for TEAM** (9 round trips, about 130 ms residual), the round trip must be roughly **≤ 40 ms**. This test can only assess the target **in a same-region environment**.

**Verdict:**
- The 3 failures stand as **failed, caused by test-machine latency**, as `docs/runbooks/staging-preparation.md` §2 requires.
- The threshold is not waived or changed.
- Neon gives no pass or fail on the 500 ms target.

### 3c. The "RLS overhead ≤ 15%" pass and the server-side timings

**They do not measure the same workload or use the same calculation:**

| | S1-17 overhead test (asserted) | Server-side timing (supplementary) |
|---|---|---|
| Source | `s1-17-performance.test.ts` lines 152–213 | `scripts/managed-db/s1-managed-run.mjs`, `serverTiming()` / `serverTimed()` |
| Where timed | Test machine, **including one network round trip** per query | Inside PostgreSQL (`DO` block, `clock_timestamp()`), no network |
| Queries | Only "own (5 owners)" | "own (5 owners)" **and** "org-wide" (no owner filter), which the overhead test does not have |
| Owners | `P.execs.slice(0, 5)`, the first 5 execs **sorted by e-mail** | the first 5 `DISTINCT owner_user_id` **sorted by UUID text**. Probably a different owner set with similar selectivity (5 of 20) |
| Execution | extended protocol, parameters, rows returned to the client | `EXECUTE` of `SELECT count(*) FROM (…)` with literals: no row transfer or serialisation |
| Ordering | RLS and baseline **interleaved** on two connections | 200 RLS runs, then 200 baseline runs, on separate sessions |
| Percentile | nearest rank (`pct()`) | `percentile_cont` (interpolated) |
| Asserted | `o50 <= 0.15` (p50 ratio) only; p95 printed | nothing (reported only) |

**Numbers from this run:**

| | RLS | Baseline | Absolute Δ | Relative |
|---|---|---|---|---|
| Client-side own, p50 | 265.55 ms | 255.73 ms | +9.8 ms | **+3.8%** (asserted, passed) |
| Client-side own, p95 | 269.08 ms | 259.77 ms | +9.3 ms | +3.6% |
| Server-side own, p50 | 0.123 ms | 0.112 ms | +0.011 ms | +9.8% |
| Server-side own, p95 | 0.137 ms | 0.136 ms | +0.001 ms | +0.7% |
| Server-side org-wide, p50 | 0.054 ms | 0.043 ms | +0.011 ms | +25.6% |
| Server-side org-wide, p95 | 0.064 ms | 0.046 ms | +0.018 ms | +39% |

**What this means:**
- **The client-side pass is not diagnostic on a WAN.** The ratio is (RTT + RLS time) / (RTT + baseline time), and the 250 ms round trip dominates both. The test would pass even if RLS doubled server execution time (0.12 → 0.24 ms), so it is weak evidence on Neon.
- **The +9.8 ms client-side gap is not RLS execution.** It is about 900× the server-side difference. It probably reflects path or session differences between the two connections (`crm_app` through the app pool, `neondb_owner` through `S1_BASELINE_URL`). This run cannot attribute it.
- **The server-side figures are the meaningful RLS evidence.** The own query is within 15% at p50 (+9.8%) and p95 (+0.7%), consistent with local p50 +0.1–6.2% and p95 +8.6–11.0%.
- **The org-wide query is over 15% in relative terms** (+25.6% p50, +39% p95), though only 0.011–0.018 ms in absolute terms. That is consistent with the fixed per-query cost of the policy InitPlan (`current_setting`) on a 0.05 ms query.
  - The S1-17 criterion as written covers only the own query.
  - **This should be reported, not hidden:** the org-wide relative overhead exceeds the ratio used for the own query.
  - Whether a relative limit is meaningful for sub-0.1 ms queries is a criteria question **for you**. I am not changing anything.
- **The query plans are identical** (`run.log`: `lead_org_id_created_at_id_idx`, Index Cond on org; execution 0.320 ms baseline vs 0.353 ms RLS).

### 3d. Changes and reruns

- **No code change is needed** to keep S1-17 correct.
- **Optional reporting improvement:** have the overhead test also print the absolute Δ, so a reader can see the WAN dilution.
- **Same-region requirement:** the 3 end-to-end tests, and a meaningful client-side overhead ratio, need the test runner in the **same region** as the database. For DigitalOcean that means a BLR1 droplet or App Platform job against the BLR1 cluster, as S1-18 intends.
- **Neon:** do **not** rerun S1-17 from this machine. It cannot change the result.

---

## 4. Other security evidence

| Evidence | Result | Assessment |
|---|---|---|
| S1-03…07 direct (`s1-03-07`) | 31/31 passed | Fail-closed reads and writes, cross-org reads, transaction-local context cleared after commit and rollback |
| S1-03…07 through the Neon pooler (`pooled-s1-03-07`) | 31/31 passed | Transaction-local context holds through PgBouncer transaction mode |
| Negative control (`mutation`): `CREATE POLICY s1_mutation_permissive ON lead FOR SELECT TO crm_app USING (true)` | **6 failed under mutation** (S1-03 ×3, S1-04 ×2, S1-07 ×1; e.g. `expected 250133n to be 0n`); policy removed; fingerprint identical; 31/31 again | **The suite does detect a real cross-tenant leak.** Only SELECT-on-lead tests can fail under this mutation, so 6 of 31 is expected |
| S1-01/02, S1-09, S1-10…12, S1-13/14, S1-15/16 | 8, 16, 11, 13, 11 passed | No failures |
| db-roles | 37/40 passed; the 3 failures are §2 | RLS enabled and forced on every table; tenant policy on every org table; no rows without context; D2 least privilege; credential tables denied; no tenant PII for the platform role |
| Final verification `crm_s1` / `crm_test` | passed: 14 / 7 org tables, all with forced RLS; 40 / 39 policies; no leftover mutation; 5 `crm_*` roles with no elevated attributes; owner `crm_migrator`; PUBLIC cannot connect | Good |

### Role memberships (identical in both databases)

| Role (granted) | Member | ADMIN | INHERIT | SET | Intended? |
|---|---|---|---|---|---|
| `crm_definer` | `crm_migrator` | f | t | t | **Yes.** Bootstrap `GRANT crm_definer TO crm_migrator`, so the migrator can own SECURITY DEFINER functions as `crm_definer` |
| `crm_app`, `crm_auth`, `crm_platform`, `crm_migrator`, `crm_definer` | `neondb_owner` | **t** | f | f | **Expected side effect, not documented.** See below |

**Direction.** `neondb_owner` is a member **of** the `crm_*` roles, i.e. it administers them. No `crm_*` role is a member of `neondb_owner` or of any provider role.

**Who can assume `crm_definer`:**
- `crm_migrator`, directly;
- `neondb_owner`, only by first granting itself SET, which its ADMIN option allows. It already has BYPASSRLS and `pg_write_all_data`, so this gives it nothing new.

**No application role can reach a more privileged role:**
- `memberships = 0` for `crm_app`/`crm_auth`/`crm_platform`;
- SET ROLE to `crm_migrator`/`crm_definer` was denied for all three.

**Why the ADMIN rows exist.** In PostgreSQL 16+, a non-superuser with CREATEROLE automatically receives ADMIN OPTION, with no INHERIT or SET, on each role it creates (`createrole_self_grant` is empty by default). It needs that to ALTER or DROP those roles later: `neon-clean.mjs` relies on it. It cannot be revoked by the admin itself. DigitalOcean's `doadmin` will get the same.

**Documentation gaps (no code risk):**
- `scripts/db/bootstrap-managed-roles.sql`, lines 50–56, says to expect "the admin no longer a member of crm_migrator". On PostgreSQL 16+, `admin_memberships_left` is **1**: the ADMIN-only creator membership. That comment should describe it.
- Neither ADR-0008 nor `docs/runbooks/staging-preparation.md` mentions it.

**Loose verification rule (tooling, not application).** `scripts/managed-db/s1-report.mjs`, around line 144, accepts **any** membership with ADMIN and no INHERIT/SET as the "creator" membership, regardless of who the member is.
- **Why it matters:** an ADMIN-only grant of one app role to another app role would pass this check, and ADMIN lets the member grant itself the role.
- **Current exposure:** none here. Every such row's member is `neondb_owner`, and `memberships = 0` on the app roles would catch the case in `db-roles`.
- **Proposed fix:** require the member to be the recorded admin user.

## 5. Proposed changes in one place (none implemented)

| # | File | Change | Effect on assertions |
|---|---|---|---|
| C1 | `spikes/s1-tenant-isolation/tests/s1-08-concurrency.test.ts` | `try/finally` around `Promise.all` to print the counters and `leakSamples`; 60 s progress line with pool counters and the slowest start wait | None |
| C2 | `spikes/s1-tenant-isolation/db/clients.ts` (`tenantRunnerFor`) | `maxWait` from `S1_TX_MAX_WAIT_MS`, default 30,000 | None. Changes a client queueing limit for a **disclosed** WAN diagnostic. **Needs your approval** |
| C3 | `tests/integration/db-roles.test.ts` | Privileged SET ROLE targets from the catalog (non-empty, must include the provider admin), plus a named per-provider list checked for existence; add `crm_platform` as a target | Stricter |
| C4 | `scripts/managed-db/s1-managed-run.mjs` | Pass the provider admin role name to `db-roles` | None |
| C5 | `scripts/managed-db/s1-report.mjs` | "Creator" membership must belong to the recorded admin | Stricter |
| C6 | `scripts/db/bootstrap-managed-roles.sql` (comment), ADR-0008, `staging-preparation.md` | Document the PostgreSQL 16+ ADMIN-only creator membership and the expected `admin_memberships_left = 1` | Docs |
| C7 (optional) | `s1-17-performance.test.ts` | Also print the absolute RLS Δ | None |

## 6. Same-region requirement

| Test | Can Neon from this machine assess it? | Needs |
|---|---|---|
| S1-17 end-to-end OWN / TEAM / ORG p95 ≤ 500 ms | **No.** The round-trip floor is 1.25–2.25 s | Runner in the same region as the database (round trip ≤ ~40 ms for TEAM) |
| S1-17 RLS overhead ≤ 15% (client-measured) | Passes, but it is not diagnostic (diluted by the round trip) | Same region, for a meaningful ratio |
| S1-08 direct and pooled with the **unchanged** 30 s `maxWait` | Only with ~2.7× headroom, and it failed twice | Same region. Neon with C2 is a disclosed diagnostic only |

## 7. Still pending for DigitalOcean (S1-18)

Neon results do not satisfy any DigitalOcean-specific item. All of the following stay **pending** and need G1 spend approval (`docs/runbooks/staging-preparation.md` §0–§2; ADR-0007):
1. **Bootstrap.** Role bootstrap as `doadmin` on BLR1 managed PostgreSQL 18: non-superuser admin, NOBYPASSRLS app roles, `crm_definer` grant, extensions, PUBLIC revoked. Record the `doadmin` creator membership.
2. **Full suite.** The full S1 suite and `db-roles`, with C3 so that `doadmin` and the DigitalOcean predefined roles are the SET ROLE targets.
3. **S1-08, unchanged.** S1-08 direct **and** through a DigitalOcean PgBouncer pool (transaction mode, inbound user, size 5), with the unchanged 30 s `maxWait`, run from BLR1. Prisma prepared statements through DigitalOcean's pool need checking; the runbook §2 fallback applies.
4. **S1-17.** S1-17 from a BLR1 runner against the 500 ms limit, plus server-side timings.
5. **Negative control and final verification** on DigitalOcean.
6. **Later gates, unaffected by this triage:** G3 real-route isolation on staging, G4 restore drill and RPO, G5 legal review.

## 8. Uncertainty

- **The S1-08 stall cannot be identified** from this run. No progress, pool counters or wait times were logged. C1 exists to capture them.
- **The pooled S1-08 behaviour** (Neon pooler sizing, pids) was not verified.
- **The round-trip counts in §3b** come from reading the code and match the timings. Prisma internals were not traced on the wire.
- **The role-catalog details** come from the preparation session, not a fresh query.
- **The +9.8 ms client-side gap** in the overhead test is not explained.
