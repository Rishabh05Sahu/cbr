# Runbook: Staging Preparation, S1-18 and Managed-Database Recovery Drill

> **Initial pilot (owner, 2026-10-26):** the database is **Supabase Free**. Use [supabase-free-setup.md](supabase-free-setup.md). The DigitalOcean-specific steps here (`doadmin`, standby, paid staging) are not approved for the pilot.

> **Status: prepared, not executed.** Every step that creates paid resources waits for the owner's written approval of the [cost estimate](../architecture/hosting-cost-estimate.md) (decision D1).
> Use **synthetic data only**. Keep the outputs of every step under `docs/architecture/spikes/results/`.

## 0. Gates (in order)

| Gate | Blocks | Evidence |
|---|---|---|
| G1 Spend approved | Any provisioning | Owner's written approval of the estimate |
| G2 **S1-18 passes on the managed DB** | Deploying the staging **application** | `spike:s1:managed` output (§2) |
| G3 Real-route isolation passes on staging | Real customer data | `test:e2e` against the staging URL (§4) |
| G4 Restore drill: 4 h target tested, effective RPO measured and documented | Real customer data | §3 results |
| G5 Legal/regulatory review complete | Real customer data | Owner-initiated (compliance notes §8) |

## 1. Provision staging database and roles (after G1)

1. **Create the database cluster.**
   - Managed PostgreSQL 18, BLR1, single node 1 GiB, inside a VPC. Trusted sources: the staging app only, plus the operator's IP during the test window.
   - Create database `crm` and a second throwaway database `crm_s1` for the spike schema.
   - **Before creating:** confirm the standby price shown for HA in the control panel (cost estimate §2).
2. **Bootstrap roles, migrate and run S1-18 with one script** (`scripts/managed-db/s1-managed-run.mjs`). It:
   - creates `crm_s1` and `crm_test`;
   - runs `scripts/db/bootstrap-managed-roles.sql` once per database, as the provider admin, with **fresh random passwords held only in memory**;
   - migrates both schemas as `crm_migrator`, never `doadmin`;
   - runs the **whole** S1 suite against `crm_s1`, re-runs S1-03…S1-08 through the connection pool if one is given, and runs `tests/integration/db-roles.test.ts` against `crm_test`.

   It checkpoints into a Git-ignored run directory, `spikes/results/managed-runs/<label>-<timestamp>/`:
   - `state.json`, the steps and batches;
   - `tests.jsonl`, one fsynced line per finished test;
   - `run.log`, scrubbed;
   - `report.{json,md}`.

   **If the run stops:** `node scripts/managed-db/s1-report.mjs <dir>` rebuilds the report, and an unfinished test is never counted as passed. Re-running with `MANAGED_RESUME_DIR=<dir>` skips finished batches and re-runs an interrupted batch whole.
   **After review:** copy the run directory into `docs/architecture/spikes/results/`.
   **Neon:** `scripts/managed-db/neon-s1.mjs` (target verification, resume) and `neon-clean.mjs` (clean restart). See [NEON-S1-TEST-REPORT.md](../NEON-S1-TEST-REPORT.md) once the run is done, and the [failure triage](../NEON-S1-FAILURE-TRIAGE.md).
   **Neon S1-08 WAN diagnostic (non-binding):** `neon-s1.mjs --diagnostic-tx-max-wait-ms <30001…600000> --batches s1-08,pooled-s1-08[,db-roles]` raises **only** S1-08's Prisma transaction-start budget (`maxWait`). It is accepted only for the verified Neon test branch, never a production branch. The run directory is `neon-diagnostic-<time>`, and the S1-08 test name, `state.json` and the report all say "DIAGNOSTIC, NON-BINDING". A diagnostic pass is **not** an S1-08 pass: S1-08 passes only with the binding 30 s, run in the same region. Further safeguards:
   - The runner accepts the override only with a one-time authorization that `neon-s1.mjs` issues after verifying the target. It is bound to that process and to the exact target, timeout, batches and endpoint hosts, so starting `s1-managed-run.mjs` directly with `MANAGED_DIAG_TX_MAX_WAIT_MS` is refused.
   - The `s1` test project refuses a `.env` that defines `S1_DIAG_*` or `MANAGED_DIAG_*`.
   - Automated readers use `report.json` `bindingPass`, which is always `false` for a diagnostic run, not `allPassed`.
   - The two S1-08 batches also get the spike pool's `S1_CONNECTION_TIMEOUT_MS` = `maxWait` + 10 000 ms (310 000 for 300 000), because pg-pool applies that timeout to waiting for a busy pool. It replaces any shell or `.env` value, the S1-08 test refuses any other value, and `state.json` and the report record the effective values per batch as configuration, separate from test outcomes.
   - `neon-clean.mjs` stops before any change while a session is open on `crm_s1` or `crm_test` (including idle pooled connections). It never ends sessions: stop the run, or wait for pooled connections to close, and retry.

   **Partial cleanup recovery (`neon-clean.mjs`).** Each statement (one GRANT, then two DROP DATABASE, then five DROP ROLE) commits on its own, so a cleanup that fails partway can leave **some objects removed and others remaining**. The admin's temporary `crm_migrator` membership (`INHERIT TRUE, SET FALSE`) is removed only when `DROP ROLE crm_migrator` succeeds; until then it remains, and the next cleanup will stop on "unexpected membership". The error says which phase failed: *before any change* (nothing changed, so fix the cause and retry), *after it started changing the test branch* (it lists the statements that completed), or *final re-verification* (the state is unverified). In the last two cases:
   1. Stop. Do not rerun cleanup blindly.
   2. Re-verify the branch identity with the approved checks: `node scripts/managed-db/neon-clean.mjs --branch-id <test branch> --dry-run` (Neon control plane, plus server identity on the direct and pooled connections). It only reads, and it prints the target and the full inventory even when it then stops (for example on the leftover membership). If the target check itself fails, stop and escalate.
   3. Inspect the live state it prints: databases and owners, `crm_*` roles, memberships, dependencies and sessions.
   4. Compare it with the expected states: clean (`neondb` and `postgres` only, no `crm_*` roles, no memberships), or partly cleaned (a subset of the original objects, possibly with the temporary membership).
   5. Decide the narrowest recovery action from that comparison (for example revoking only the leftover temporary membership), get it approved, and let the full safety checks run again before any destructive step.
   6. If the state is anything else, escalate for manual review. Never drop other objects, terminate sessions or touch production resources to make the cleanup finish.

   **Long-running managed tests (S1-08 takes hours).** The Neon diagnostic of 2026-10-21/22 lost one attempt when a background shell was stopped for low memory, and invalidated another when the laptop entered Modern Standby for about 17 minutes mid-run.
   - Run from a normal, persistent PowerShell window that stays open, not from a disposable or background shell.
   - Keep the laptop plugged in, and prevent sleep and Modern Standby for the whole run with your own Windows power settings. The scripts never change power settings.
   - Don't run memory-heavy applications at the same time.
   - S1-08 prints a UTC-stamped progress line about every 60 s. A gap of more than 120 s (`[S1-08] PROGRESS GAP (run invalid)`, and `validForAcceptance: false` in the final line) makes the run **invalid for acceptance**: the test fails whatever its counters say. The gap and its timestamps are observed facts; the cause (sleep, suspension, an event-loop stall) is not determined by the test. Inspect `run.log` and the operating system's event log before deciding, with approval, whether to resume or restart.
   - Pooled S1-08 (`pooled-s1-08`): instead of `distinct server pids <= 5`, which does not measure the client pool behind Neon's transaction-mode pooler, it requires a client-pool peak of at most 5 and cross-tenant backend reuse in every direction (each ordered pair of the three test orgs observed consecutively on one backend). The direct `s1-08` keeps `pids <= 5`.
   - db-roles records the SQLSTATE of every refused `SET ROLE` and checks that `current_user` is unchanged. PostgreSQL's own refusal (42501, "permission denied") always counts, and is the only one accepted for the provider admin (`neondb_owner`), `cloud_admin`, `neon_service` and the `crm_*` roles. Neon's own refusal (SQLSTATE `XX000`, observed in run `neon-2026-10-22T14-15-42-148Z`) counts only when all of these hold: the server itself confirms the verified Neon test branch and endpoint, the role is on the reviewed list of 15 (`neon_superuser` and 14 `pg_*` roles, `tests/support/set-role.ts`), the message is exactly `It is not allowed to change role to <role>`, `current_user` is unchanged, and the role is not reachable as a member. `XX000` is PostgreSQL's generic internal-error code, so it is never enough alone.
   - The runner exits non-zero when any selected batch has a failed, blocked or unrun test, its test process failed, a setup step failed, or a bootstrap/final-verification check did not pass. It prints the reasons, and `report.md`/`report.json` stay the authority for counts. Exit 0 means only that the selected work passed; the S1 verdict is `bindingPass`, never true for a diagnostic or partial run.
   **Expected memberships after bootstrap** (checked by the report): `crm_definer` ← `crm_migrator` (INHERIT, SET), and every `crm_*` role ← the provider admin with ADMIN OPTION only (PostgreSQL 16+, ADR-0008 #18). The application roles are members of nothing.
   ```bash
   MANAGED_ADMIN_URL='postgresql://doadmin:…@<host>:25060/defaultdb' \
   MANAGED_CA_FILE=./ca-certificate.crt \
   MANAGED_POOL_NAME=s1-pool \
   node scripts/managed-db/s1-managed-run.mjs
   ```
   **Inputs:**
   - **Admin URL:** taken from the provider panel and passed **only** as an environment variable.
   - **CA certificate:** downloaded from the panel. `*.crt` is Git-ignored. TLS is `verify-full`.
   - **Pool:** before the run, add database `crm_s1` in the panel. The admin owns it, so the bootstrap works unchanged. Then create pool `s1-pool` on it: transaction mode, **inbound user**, small size (e.g. 5). The script connects through it as `crm_app`, whose password exists only in the script's memory.

   **Bootstrap lessons from the local rehearsal (2026-10-20).** The rehearsal used PostgreSQL 18.6 with a non-superuser admin that has CREATEROLE, CREATEDB and BYPASSRLS, like `doadmin`.
   - A non-superuser admin can transfer database/schema ownership only while it may `SET ROLE` to the new owner (PostgreSQL 16+). The script grants itself **SET-only** membership in `crm_migrator` and revokes it immediately afterwards.
   - A database's `REVOKE … FROM PUBLIC` and `CREATE EXTENSION` must run **while the admin still owns the database**. After the ownership transfer they silently do nothing: the REVOKE gave only a warning and `PUBLIC` kept `CONNECT`. The script now orders them correctly and prints `public_can_connect` (must be `f`).

   **Stop condition:** if the provider admin cannot create `NOBYPASSRLS` roles, grant `crm_definer` to `crm_migrator`, or create the extensions, **S1-18 has failed**. Record why and assess the hosting change (ADR-0007) before going further.

## 2. S1-18: staging parity (managed database)

Run by the script above. Pass criteria:
- every S1 test file passes on the managed database (S1-01…S1-17; S1-09 is code-level and runs anyway);
- S1-08 has **0 leaks** directly and through the pool;
- the production-schema role checks pass;
- all `crm_*` roles show `rolsuper = f` and `rolbypassrls = f`.

**S1-17 note:** the test machine's round-trip time to the database (recorded by the script) adds to every latency. The 500 ms p95 limit applies as written. If a failure is caused only by test-machine latency, record it as such. **Do not** relax the limit. Instead, re-run from a machine in the same region.

**Through the pool (PgBouncer, transaction mode):**
- **Pass:** 0 leaks.
- **Fail:** if Prisma prepared statements break through the pool, record it. Use a direct connection with small pool caps instead; do not change the tenant context mechanism.

**Record:**
- the date;
- the provider version (`SELECT version()`, in the results JSON);
- the full output;
- pass/fail per criterion.

## 3. Managed-database recovery drill (measures RPO and RTO)

The provider PITR window (7 days) says **how far back** you can go, **not how much recent data you can lose**. Measure RPO; do not infer it.

1. **Seed.** Seed staging with the synthetic dataset (`DRILL_*` sizes as in `scripts/recovery/logical-restore-drill.mjs`).
2. **Write markers.** Start a writer that commits a marker row with `clock_timestamp()` every second, through the app role, and logs each acknowledged commit with its timestamp.
3. **Start the clock.** Note T0 (declare incident) and keep the writer running.
4. **Fork.** Use the provider's PITR fork to a new cluster ("Restore from backup → point in time = latest available").
5. **Time the restore.** Note T1 when the fork is available. RTO for the database step = T1 − T0.
6. **Measure RPO.** Compare the last acknowledged marker in the writer log with `max(at)` in the fork. **RPO = difference.** Repeat 3 times and report the worst case.
7. **Full service recovery.**
   - Repoint the staging app secrets to the fork.
   - Run migrations: no-op expected.
   - Run smoke tests (`/api/health`, sign-in, a tenant page).
   - Note T2. **Service RTO = T2 − T0. Target: ≤ 4 h.**
8. **Off-site copy.**
   - Restore the latest nightly `pg_dump` from Spaces into a scratch cluster.
   - Verify with the same fingerprint as the local logical drill.
9. **Report.** Document the RPO, RTO, failure modes found and limitations in `docs/architecture/recovery-test-results.md`.

**Local method validation (already done, 2026-10-20):** `pnpm drill:logical` and `pnpm drill:pitr`. Results: [recovery-test-results.md](../architecture/recovery-test-results.md).

## 4. Staging application (after G2)

1. **Secrets.** Store in App Platform encrypted env vars, never in the repo:
   - `DATABASE_URL` (crm_app), `AUTH_DATABASE_URL` (crm_auth), `PLATFORM_DATABASE_URL` (crm_platform);
   - `REDIS_URL` (TLS `rediss://`), `BETTER_AUTH_SECRET` (32+ random bytes), `BETTER_AUTH_URL`;
   - `SMTP_*`, `EMAIL_FROM`;
   - `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` (same value for every web instance).
2. **Deploy.** Deploy images built by CI:
   - `web`, `worker`;
   - `migrate`, which runs as a pre-deploy job, as `crm_migrator`.
3. **Check the client IP header.** Confirm the load balancer **overwrites or appends** `X-Forwarded-For`. Better Auth uses it for rate-limit keys, and a client-supplied value must not be trusted. If the platform only appends, configure the trusted-proxy setting accordingly and re-run the rate-limit e2e test.
4. **Run the real-route suites against staging.** Set the e2e base URL to staging and seed synthetic orgs through the platform console:
   - `tests/e2e/auth-routes.test.ts`;
   - `tests/e2e/route-isolation.test.ts`.
5. **Verify response hardening:**
   - HSTS, CSP and Secure cookies (`__Secure-cbr.session_token`);
   - TLS 1.2+;
   - no `x-powered-by`.
