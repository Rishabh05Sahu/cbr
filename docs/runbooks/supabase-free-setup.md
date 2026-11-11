# Runbook: Supabase Free as the pilot database (four companies)

> **Status (2026-10-26): prepared, not executed.**
> - **Rehearsed locally:** the procedure below ran on a disposable **PostgreSQL 17** server set up like Supabase:
>   - a non-superuser admin with CREATEROLE, CREATEDB and BYPASSRLS owning the database and `public`;
>   - Supabase's API roles, with default privileges granting them everything.
>
>   Evidence is in §9.
> - **Not done:** nothing has touched a Supabase project.
> - **Approvals:** every step marked **APPROVAL** needs the owner's explicit go-ahead in chat before it runs.
> - **Secrets:** never put a secret in this file, in Git, in chat, or in a ticket.

## 1. What runs where (the pilot)

| Service | Needed for | Status |
|---|---|---|
| **PostgreSQL** | All data | **Supabase Free** (this runbook) |
| **Object storage** (import uploads, export files; private bucket) | Imports, exports | Already implemented on Supabase Storage ([supabase-storage-setup.md](supabase-storage-setup.md)) |
| **Web app** (Next.js standalone, `Dockerfile` target `web`) | Everything | **Not covered by Supabase.** Needs a host |
| **Worker** (`Dockerfile` target `worker`: outbox relay, import steps, exports, e-mail, file cleanup) | Imports, notifications, e-mail, cleanup | **Not covered by Supabase.** A long-running process |
| **Valkey/Redis** | Job queues (BullMQ), rate limits, the per-org search budget | **Not covered by Supabase** |
| **SMTP** | E-mail verification (required at sign-in), invitations, password reset | **Not covered by Supabase** for our use: the app sends its own mail |

Hosting options are in [PHASE-2-M6-READINESS.md](../PHASE-2-M6-READINESS.md) §6. Nothing has been provisioned.

## 2. Supabase Free limits that matter (checked 2026-10-26; re-check before relying on them)

| Limit | Value | Source | Consequence for the pilot |
|---|---|---|---|
| Database size | **500 MB** quota, counted across the organisation's projects. Above it, requests can be restricted (HTTP 402) | [Billing](https://supabase.com/docs/guides/platform/billing-on-supabase), [Database size](https://supabase.com/docs/guides/platform/database-size) | Four companies fit (estimate in readiness §6). Watch Usage monthly |
| Disk | 2 GB fixed; **read-only at 95%** | [Database size](https://supabase.com/docs/guides/platform/database-size) | Same |
| Compute | Nano: up to 0.5 GB RAM, shared CPU; 60 direct connections; 200 pooler clients | [Compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk) | Keep pools small (§5) |
| Pausing | **Paused after 7 days of inactivity**; restorable from the dashboard | [Pricing](https://supabase.com/pricing), [Production checklist](https://supabase.com/docs/guides/deployment/going-into-prod) | A paused project stops the CRM until someone restores it |
| Backups | **No automatic backups and none downloadable on Free** | [Pricing](https://supabase.com/pricing), [Production checklist](https://supabase.com/docs/guides/deployment/going-into-prod) | **Our own encrypted dumps** (§8) are the only recovery |
| Storage / egress | 1 GB file storage; 5 GB egress per month | [Billing](https://supabase.com/docs/guides/platform/billing-on-supabase) | Import and export files are deleted within hours (fine). Egress includes database traffic to our host: measure it in the first weeks |
| Network | Direct connection IPv6 only on Free; **shared pooler (Supavisor) is IPv4**: session mode port 5432, transaction mode port 6543 | [Connecting](https://supabase.com/docs/guides/database/connecting-to-postgres) | The app, worker and migrations use the **session pooler** |
| Pooler user name | `<role>.<project-ref>` | same | Supported by `src/env.ts` (§9) |
| PostgreSQL version | Supabase offers PostgreSQL **17**; no official evidence of 18 for hosted projects was found | [Changelog](https://supabase.com/changelog/46080-self-hosted-supabase-upgrading-from-pg-15-to-17-breaking-change.md) | Handled: the bootstrap adds `uuidv7()` when missing (§9) |
| Data API (PostgREST) | Exposes the `public` schema to `anon`, `authenticated` and `service_role` (`service_role` bypasses RLS). Auto-grants apply to objects **created by `postgres`**; from 2026-10-30 new tables are no longer auto-exposed | [Securing your API](https://supabase.com/docs/guides/api/securing-your-api), [Roles](https://supabase.com/docs/guides/database/postgres/roles), [Changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) | The CRM never uses the Data API. Our objects are created by `crm_migrator`, so they get no API grants; `verify-supabase.sql` proves it. Optional hardening in §6 |

## 3. Create the project (owner)

1. Create **one** Free project for the pilot.
   - **Region:** pick the one closest to the users from the list the dashboard shows. For India that is normally "South Asia (Mumbai)", if listed.
   - The app host must be in the same region: an earlier managed run failed partly because of a 250 ms round trip (`docs/NEON-S1-FAILURE-TRIAGE.md`).
2. Choose a strong database password and keep it in your password manager. **This is the `postgres` admin password.** It is used once, for the bootstrap (§4). It never goes into any app environment.
3. Note the **PostgreSQL version** (Settings → Infrastructure). It must be **17 or later**.
4. **Do not** enable extensions from the dashboard before the bootstrap. If `citext`, `btree_gist` or `pg_trgm` is already enabled in another schema, the bootstrap's extensions step stops: ask for a review. Do not move extensions blindly.

## 4. Local environment and the one-time bootstrap

1. **Connection strings.** In the dashboard's **Connect** panel, copy the **Session pooler** string. Note its host and the project ref; never paste them anywhere public.
2. **Passwords.** Generate five passwords locally, one per role (`crm_migrator`, `crm_app`, `crm_auth`, `crm_platform`, `crm_cleanup`), each independently: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` (32 characters; URL-safe, so no percent-encoding). Never reuse one across roles, projects or the local setup. Store them only in your password manager and `.env`.
3. **One file: the existing `.env`.** Add the `ACCEPTANCE_*` block from `.env.example` and fill it in your editor. **Never paste the values into chat or tickets.**
   - **Leave every other line unchanged.** The unprefixed variables stay the local development setup. The older project's `SUPABASE_URL` and key are never used for acceptance.
   - **The prefix provides the isolation.** The acceptance scripts parse `.env` themselves and read only `ACCEPTANCE_*` names. They never read the process environment or an unprefixed variable, so they can't fall back to `DATABASE_URL`, `crm_dev`, `crm_test` or the older project.
   - **Role URLs:** `ACCEPTANCE_DATABASE_MIGRATOR_URL`, `ACCEPTANCE_DATABASE_URL`, `ACCEPTANCE_AUTH_DATABASE_URL`, `ACCEPTANCE_PLATFORM_DATABASE_URL` and `ACCEPTANCE_CLEANUP_DATABASE_URL`, in the form `postgresql://crm_<role>.<ref>:<password>@<pooler-host>:5432/postgres`. Each password must equal its `ACCEPTANCE_CRM_<ROLE>_PASSWORD`.
   - **Admin login (bootstrap only):** `ACCEPTANCE_PGHOST` (the same pooler host), `ACCEPTANCE_PGPORT=5432`, `ACCEPTANCE_PGDATABASE=postgres`, `ACCEPTANCE_PGUSER=postgres.<ref>`, `ACCEPTANCE_PGPASSWORD` (the database password), `ACCEPTANCE_PGSSLMODE=verify-full` and `ACCEPTANCE_PGSSLROOTCERT` (below). Clear `ACCEPTANCE_PGPASSWORD` after the bootstrap.
   - **CA certificate (required; there is no unverified mode):**
     1. In the acceptance project's dashboard, open **Database Settings → SSL Configuration** and choose **Download certificate**.
     2. Save the file **outside the repository**, for example `C:\Users\<you>\supabase\cbr-crm-acceptance-ca.crt`. It is a public certificate, not a secret; keeping it outside the repository just keeps it out of Git.
     3. Set `ACCEPTANCE_PGSSLROOTCERT` to its absolute path. Forward or back slashes both work, but the path must not contain commas or quotes.

     **Checked before any connection:**
     - the file exists, is readable and is under 64 KB;
     - it contains only PEM certificates (a private key is refused);
     - each certificate parses, is currently valid and is a CA.

     **At connection time:**
     - The file is bind-mounted **read-only** into the `psql` container at `/run/crm-acceptance/supabase-root.crt`, and `PGSSLROOTCERT` points there. The Windows path is only in Docker's `--mount` option, never in the container's environment.
     - Before `psql` starts, a guard in the container confirms the file is readable, is mounted `ro` (from `/proc/mounts`) and that `sslmode` is `verify-full`. Otherwise it exits 90 without connecting.
     - libpq then verifies both the certificate chain and the pooler's host name.
     - A missing, invalid or wrong certificate stops everything. Nothing ever falls back to `require` or to an unverified connection.
   - **`git check-ignore .env` must print `.env`.**
4. **Local check, with no network:**
   ```sh
   node scripts/db/supabase-acceptance-preflight.mjs --config
   ```
   It prints one pass or fail line per check, plus the masked ref. It never prints a value. The checks:
   - `.env` is ignored by Git and not tracked;
   - the ref has 20 characters and is not the older `SUPABASE_URL` project, unless `ACCEPTANCE_ALLOW_EXISTING_PROJECT=true` (exactly `true`) deliberately allows that project. The opt-in skips only this check. Every credential, host, URL and TLS check still runs, and the read-only preflight still stops if the project already has CRM roles, the `app` schema, `_prisma_migrations` or any `public` table;
   - every URL uses `crm_<role>.<ref>`, one `*.pooler.supabase.com` host, port 5432, database `postgres` and no extra parameters;
   - each URL's password matches its variable;
   - the five passwords are 24 or more characters, all different, not placeholders, and not used by any local setting;
   - the admin user is `postgres.<ref>` on the same host;
   - the SSL mode is `verify-full`, and any `sslmode` in a role URL is `verify-full` too;
   - the CA file passes the checks above;
   - each URL's password is correctly percent-encoded. A URL must percent-encode reserved characters such as `@ : / ? # % [ ]` (for example with `encodeURIComponent`). The generated base64url passwords contain none.

   **Then, only when explicitly approved, the read-only check:**
   ```sh
   node scripts/db/supabase-acceptance-preflight.mjs --read-only
   ```
   It repeats the local checks, then runs `psql` once as the admin in the same throwaway container as the bootstrap. The connection is `verify-full`, with the CA mounted read-only, inside a `READ ONLY` transaction that is rolled back. It reports:
   - the PostgreSQL version, database and user;
   - the admin's role attributes;
   - the three extensions (available, or installed and in which schema) and any others;
   - any `crm_*` role with its safety attributes;
   - leftovers from an earlier setup: schema `app`, `_prisma_migrations`, tables in `public`, `public.uuidv7()`.

   **It stops (exit 1) if anything differs from a fresh project:**
   - PostgreSQL older than 17;
   - a `crm_*` role already exists;
   - an extension sits outside `public`;
   - a leftover exists.

   It doesn't try any CRM role, since none exists before the bootstrap.
5. **APPROVAL A: roles and grants** (all six roles, including `crm_cleanup`). Runs as `postgres` through the session pooler with `psql` 17 in a throwaway container:
   ```sh
   node scripts/db/bootstrap-supabase.mjs --run
   ```
   **Scope:** `bootstrap-supabase.sql` and `provision-cleanup-role.sql`, in one transaction, and nothing else.
   - It creates `crm_migrator`, `crm_app`, `crm_auth`, `crm_platform` and `crm_cleanup` (all `LOGIN`), plus `crm_definer` (`NOLOGIN`, granted to `crm_migrator`). All six are `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`; `crm_cleanup` is also `NOINHERIT` with a limit of two connections.
   - It sets the per-role timeouts.
   - It grants `CONNECT` on `postgres` to the five login roles, `CREATE` on the database and `USAGE, CREATE` on `public` to `crm_migrator`, and `USAGE` on `public` to `crm_app`, `crm_auth`, `crm_platform` and `crm_definer`.
   - It creates **no** extension, function, schema or table, and applies no migration.

   **How the passwords are handled:**
   - `bootstrap-supabase.mjs` validates the whole acceptance configuration first, with the same checks as step 4 and no network. It then computes a SCRAM-SHA-256 verifier for each role on your machine (`scripts/db/scram.mjs`), from `ACCEPTANCE_CRM_<ROLE>_PASSWORD`.
   - The verifiers become psql variables on the container's stdin (`set`, client-side). The plaintext passwords never reach the server, a command line, the terminal or any file other than `.env`.
   - The admin login reaches psql as `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD` in the child process's environment only, with `PGSSLMODE=verify-full` and `PGSSLROOTCERT` set to the container path of the read-only CA mount. These are mapped from `ACCEPTANCE_PG*`, and every other database-related variable is removed first. `docker` sees only the names (`-e PGHOST`), never a value.
   - The SQL refuses anything that is not a SCRAM verifier. Errors name variables, never values; psql runs with terse errors and no echo.
   - **Reruns change no password.** The four main roles are created only if `crm_migrator` is missing. If `crm_cleanup` already exists, its verifier is dropped before `provision-cleanup-role.sql` runs, which then keeps its password.

   **Keeping the verifiers out of Supabase's logs (`quiet_ddl`, always on for `--run`):**
   - **Two places would record them.** One is the server log: Supabase logs DDL for `postgres` by default. The other is `pg_stat_statements`, which on PostgreSQL 17 stores `CREATE ROLE` and `ALTER ROLE … PASSWORD` text verbatim, verifier included, even with logging off. A local probe confirmed both.
   - **The first statements of the transaction switch these off for the transaction only:** `SET LOCAL log_statement = 'none'`, `log_min_duration_statement = -1` and `log_min_error_statement = 'panic'`. Where loaded, they also set `pgaudit.log = 'none'` and `pg_stat_statements.track_utility = off`.
   - **Before any verifier is sent, they check the effective values.** The check also requires `log_min_duration_sample = -1`, `log_transaction_sample_rate = 0` and the three `debug_print_*` settings off. If anything differs, the bootstrap stops, nothing is applied and no verifier has left your machine.
   - **Nothing persistent changes.** There is no `ALTER SYSTEM`, `ALTER ROLE … SET` or `ALTER DATABASE` for logging; the settings end with the transaction.
   - **Why `postgres` may set these on Supabase:** `supautils` allows its privileged role to `SET` exactly these parameters (`privileged_role_allowed_configs`: `log_statement`, `log_min_error_statement`, `log_min_duration_statement`, `pgaudit.log`, `pg_stat_statements.*`). It runs such a `SET` with elevated rights inside a transaction ([supautils](https://github.com/supabase/supautils), [Supabase's config](https://github.com/supabase/postgres/blob/develop/ansible/files/postgresql_config/supautils.conf.j2), [custom Postgres config](https://supabase.com/docs/guides/database/custom-postgres-config)).
   - **Not yet confirmed on this project:** whether its `postgres` role holds that privilege. The run itself is the test. If the `SET` is refused, the run fails with "permission denied to set parameter", before any verifier is sent, and nothing is applied.
   - **Not covered:** logging outside PostgreSQL's own settings, such as anything the pooler or Supabase's platform records. Nothing reviewed here indicates that either records statement text, but this has not been verified.
   - **The role URLs** (for the app and tests later) are not yet used for any connection. When they are, those connections need `verify-full` as well. A role URL may already set `sslmode`, but only to `verify-full`. `verify-full` through the shared pooler itself is confirmed: the read-only preflight on 2026-10-27 connected with it.
   - `--emit-sql` writes the same script, guard included, to a pipe for a local rehearsal. It refuses a terminal; never redirect it to a file. `--emit-sql --allow-ddl-logging` drops the guard, for a local non-superuser admin that may not set these parameters. Never use it against Supabase; `--run` has no such option.
   - Do not run `provision-cleanup-role.mjs` on its own against Supabase. It reads the unprefixed local variables and has no logging guard.

   **Expected:** no `crm_*` row with `rolsuper` or `rolbypassrls`; `migrator_can_create_schema` and `migrator_can_create_in_public` both `t`; `crm_cleanup: role created` (or, on a rerun, `password unchanged`), then the row `f|f|t|f|0`.

6. **APPROVAL B: extensions and `uuidv7()`.** A separate, later step:
   ```sh
   node scripts/db/bootstrap-supabase.mjs --run-extensions
   ```
   **Scope:** `bootstrap-supabase-extensions.sql`, in one transaction.
   - It creates `citext`, `btree_gist` and `pg_trgm` in `public`, and stops if one is already installed in another schema.
   - On PostgreSQL 17 it creates `public.uuidv7()`, executable only by the five CRM roles and `crm_definer`, and revoked from `PUBLIC`, `anon`, `authenticated` and `service_role`.
   - It never replaces an existing `public.uuidv7()` it didn't create. It keeps one that carries its own comment, is plain SQL returning `uuid` and belongs to no extension; anything else stops the step. A local rehearsal on 2026-10-27 confirmed this: a foreign function was refused and nothing was created; a rerun kept the step's own function.
   - It sends no password or verifier, and creates or alters no role. It stops if the roles from step A are missing.

   **Expected:** the three extensions in `public`; `uuidv7` reports `compat` (PostgreSQL 17) or `built in` (18).

   Migrations (§6) are a third step, approved separately again.

## 5. Connection modes and pool sizes

**Mode: session pooler for everything** (migrations, web, worker). It is IPv4, supports prepared statements and session-level advisory locks, and suits long-running processes ([Connecting](https://supabase.com/docs/guides/database/connecting-to-postgres)).
- Tenant context is transaction-local (`set_config(..., true)`), so it would also be safe in transaction mode (6543). Not needed for a persistent host.

**Pool sizes:** set `DATABASE_POOL_MAX=4`.
- Web: crm_app 4 + crm_auth 2 + crm_platform 2 = 8 connections.
- Worker: the same plus crm_cleanup 1 = 9.
- That is about 17 of Nano's 60, leaving room for Supabase's own services.

The application refuses to start if a runtime URL logs in as an admin (`postgres`, `postgres.<ref>`, `crm_migrator`) or as the wrong role.

## 6. APPROVAL: migrations, then verification

Run migrations **only** through `scripts/db/migrate-supabase.mjs`, never `prisma migrate deploy` against Supabase. Offline tests on 2026-10-27 found two reasons:
- **Prisma 7 doesn't roll back a migration that fails partway.** The statements before the error stay, and recovery needs manual cleanup.
- **Prisma's schema engine ignores `sslmode=verify-full`.** It connects without checking the certificate, and `sslmode=require` alone also accepts a wrong CA.

**What the wrapper does:**
- **Connection:** it reads only `ACCEPTANCE_DATABASE_MIGRATOR_URL`, after the full acceptance validation, and never the local `DATABASE_MIGRATOR_URL`.
- **One transaction per migration:** each migration runs in psql with `verify-full` against the read-only CA mount. The transaction takes an advisory lock, checks that the recorded history is exactly the migrations before it, runs the unchanged `migration.sql`, and adds a row to `public._crm_migration_marker`. That small table has RLS forced and no grants.
- **Recording:** after `COMMIT`, Prisma records the migration (`migrate resolve --applied`) using `scripts/db/prisma.supabase.config.mjs`. That config doesn't load `.env`, and the connection uses `sslmode=require&sslcert=<CA>&sslaccept=strict`, which checks both the chain and the host name. The wrapper then reads the ledger back.
- **Before anything runs:** the 27 reviewed migrations (0001–0027) must match their reviewed SHA-256 and pass a static check: no transaction control, no `CONCURRENTLY`, no psql meta-commands or variables.
- **Crash gap:** if the SQL committed but Prisma didn't record it, every later run detects this from the marker and stops without re-running anything. After review, `--record-committed <migration>` records it without running SQL.
- **Concurrency:** a lock file stops a second run on the same machine. The advisory lock and history check stop the same migration being applied twice from elsewhere. Neither stops other tools.

1. **APPROVAL: read-only status:** `node scripts/db/migrate-supabase.mjs --status`. It runs a read-only psql transaction, then `prisma migrate status`, which only runs `SELECT`s (checked offline with every statement logged). It must show the session as `crm_migrator`, read-only and using TLS, show Prisma connected with strict TLS, list exactly 0001–0027 as pending, and report no problems. `--deploy` runs this check first, so a Prisma TLS failure stops it before anything is committed.
   - **0001–0006:** schema, RLS, roles' grants.
   - **0007:** stored generated column. It rewrites `lead`, which is empty on a new project.
   - **0008:** index. It's built without `CONCURRENTLY`, which is fine on an empty table.
   - **0009–0027** (reviewed 2026-11-11): imports, tags, tasks and follow-ups, call scripts, contact status, phone masking, interactions, properties, site visits. Each new table has RLS forced and grants only to CRM roles; three new SECURITY DEFINER functions (`script_version_is_published`, `task_reminders_claim`, `site_visit_reminders_claim`) follow 0002's pattern. Nothing needs PostgreSQL 18: no function body calls `uuidv7()` (column defaults bind to `public.uuidv7()` when the table is created). Rehearsed on PostgreSQL 17 (§9).
2. **APPROVAL: apply:** `node scripts/db/migrate-supabase.mjs --deploy`. It stops at the first problem: a failed migration is rolled back, and the migrations after it don't run.
3. **APPROVAL: verify (read-only):** `node scripts/db/migrate-supabase.mjs --verify`.
   - **How it runs:**
     - First it scans `scripts/db/verify-supabase.sql` and refuses to run it if it finds anything that could write: write or DDL keywords, `SELECT INTO`, state-changing functions, `DO` blocks, or any psql meta-command except `\set ON_ERROR_STOP on`.
     - It then runs `--status`, which needs all 27 migrations applied and both TLS paths verified.
     - It runs the file as `crm_migrator` inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`.
   - **What passes:** every check 1–14 must appear exactly once with `ok = t`. A missing check, a duplicate or a psql error is a failure.
   - **The 14 checks:**
     - exactly migrations 0001–0027 in the history;
     - exactly 44 application tables, plus the marker table owned by `crm_migrator`;
     - RLS enabled and forced on all 45;
     - the API roles exist, so their checks aren't vacuous;
     - no table or column privilege for the API roles or `PUBLIC`;
     - no `EXECUTE` on CRM functions and no `USAGE` on `app` for the API roles;
     - no `crm_*` role is superuser or BYPASSRLS, and the six roles exist exactly;
     - `uuidv7` executable by `crm_app` and not by `PUBLIC`;
     - the extensions are in `public`;
     - schema `app` is owned by `crm_migrator`;
     - exactly 11 security-definer functions, owned by `crm_definer`, with a fixed `search_path` and no `PUBLIC` `EXECUTE`.
   - **Table names:** the wrapper also compares every table name against the 44 tables the migrations create, plus `_crm_migration_marker`. Expect 45.
   - **Rehearsed offline (2026-10-28):**
     - it passed with no writes in the server log;
     - each piece of tampering failed the expected check: `anon` given `SELECT`, RLS not forced, `PUBLIC` given `EXECUTE` on `uuidv7` or on a definer function, a stray table;
     - a file containing a `DELETE` was refused without connecting;
     - a broken check was a failure;
     - running before the migrations was refused, and a wrong CA failed closed.

4. **Optional hardening:** in **Settings → Data API**, remove `public` from the exposed schemas, or disable the Data API. The CRM does not use it. Storage keeps working, since it has its own API. Re-run step 3 afterwards.

## 7. Storage, application checks and the four-company acceptance

1. **Storage:** create the private bucket exactly as in [supabase-storage-setup.md](supabase-storage-setup.md), with the same name, size limit and MIME types. **No other bucket** is needed.
2. **Acceptance on synthetic data.** Use a **second, disposable Free project** set up the same way (§3–§6), so the pilot project never holds test data:
   - Four synthetic companies (A–D). Each Owner and executive can see only their own company's leads, imports, exports, notifications and search results. Cross-company ids return 404 or NOT_FOUND.
   - Sign-in with e-mail verification; 2FA for Owner and Admin.
   - Lead create, import (CSV and XLSX), duplicates and returning customers, re-upload, assignment (target and round-robin), search including the 10/s limit, list paging, archive and restore.
   - **Worker restart during an import:** completes exactly once.
   - **Importer:** set-based by default. Confirm the worker log shows `importCommitStrategy: "set"`. Then restart the worker with `IMPORT_COMMIT_STRATEGY=row`, run one small import, confirm `"row"` and identical counts, and restore the default.
   - **Blocker:** the existing integration and E2E suites refuse any database that is not named `crm_test`, because they empty it. Running them against the disposable Supabase project needs a small, reviewed change to that guard, an explicitly named acceptance target. **That change needs the owner's approval** and is not made.
3. **Mobile:** the everyday screens at 390 px (sign-in, lead list, lead detail, create, import status), checked by the M5 review. Re-check them on the deployed host.

## 8. Backups and restore drill (no paid product)

| Step | How |
|---|---|
| **When** | Nightly during the pilot, before every migration, and before any bulk import |
| **Export** | `pg_dump --format=custom --schema=public --schema=app --enable-row-security` from the session pooler **as `crm_migrator`**.<br>• **Keep owners and privileges:** do **not** use `--no-owner` or `--no-privileges`. The SECURITY DEFINER functions must stay owned by `crm_definer`, and the grants are part of the security model.<br>• **`--enable-row-security` is required:** RLS is forced on the owner too, and without it `pg_dump` stops ("query would be affected by row-level security policy"). The migrator's `maintenance` policy then returns every row.<br>• **Version:** use `pg_dump` **17** (Docker `postgres:17-alpine`), never older than the server.<br>• **Connection:** from `PG*` environment variables only; never printed or logged.<br>• **Row counts:** record them per table at dump time, for the restore check |
| **Encrypt** | Encrypt immediately (for example `age` or 7-Zip AES-256 with a passphrase kept in the password manager). Delete the unencrypted file |
| **Store** | Outside the repository and outside the machine, for example an encrypted file in the owner's cloud drive, plus one offline copy. Keep 14 daily and 8 weekly copies |
| **Restore drill (weekly in the pilot, and after any schema change)** | 1. Decrypt into a temporary folder.<br>2. Start a **disposable local PostgreSQL 17** with a non-superuser admin (as rehearsed, §9).<br>3. Bootstrap it with `scripts/db/bootstrap-supabase.mjs --emit-sql` (§4; includes `crm_cleanup`).<br>4. Restore with **`scripts/db/restore-dump.sh <dump>`** as `crm_migrator`. It restores schema `app` and its grants first, then the rest, skipping Supabase's `public` schema entries, the bootstrap's `uuidv7()` and platform default privileges; it refuses a non-empty target.<br>5. Run `scripts/db/verify-supabase.sql`.<br>6. Remove the disposable database.<br>The same script restores into a **new Supabase project** after its bootstrap |
| **Restore integrity** | A backup is valid only after a restore succeeded and **row counts per table equal the source's** (count them at dump time). Also: RLS is enabled and forced on all 27 tables, and a `crm_app` query with no tenant context returns 0 rows |
| **Recovery objective** | RPO ≤ 24 h (nightly dumps). RTO: restore into a new Free project, about 1–2 h, to be measured by the first drill |

## 9. Evidence from the local rehearsal (2026-10-26)

**Setup:** a disposable `postgres:17-alpine` container (PostgreSQL 17.11), memory-only, port 55433, removed afterwards.
- `supa_admin`: NOSUPERUSER, CREATEROLE, CREATEDB, BYPASSRLS; owns the database and `public`.
- The roles `anon`, `authenticated` and `service_role`, with default privileges granting them ALL.

| Step | Result |
|---|---|
| `bootstrap-supabase.sql` as `supa_admin` | **OK.** Five roles, none superuser or BYPASSRLS. Extensions in `public`. `uuidv7` = compat, granted to the five CRM roles only |
| `provision-cleanup-role.mjs --emit-sql` as `supa_admin` | **Failed first:** PostgreSQL 16+ lets only a superuser *name* SUPERUSER, BYPASSRLS or REPLICATION in ALTER ROLE. That affects every managed host. **Fixed:** those three are now checked (the script stops if any is set), not set. Then OK |
| `prisma migrate deploy` as `crm_migrator` | **All 8 migrations applied** |
| `verify-supabase.sql` as `crm_migrator` | **All 10 checks `ok = t`.** The API roles got **no** privilege on CRM objects despite the permissive defaults |
| Compat `uuidv7()`, 20,000 ids as `crm_app` | All distinct, version 7, RFC variant, timestamp within 1 ms, **0 out of order** within a session |
| **Full integration project on this server** (the `TEST_*` URLs pointed at it; `crm_test` untouched) | **26 files, 469/469, exit 0**: cross-org isolation, database roles, RLS, imports (both strategies), search, hygiene, exports |
| Backup: `pg_dump` as `crm_migrator` **without** `--enable-row-security` | Fails, as expected under forced RLS |
| Backup: `pg_dump … --enable-row-security` | OK: 737 KB, 28 tables, 10,647 rows |
| Restore into a freshly bootstrapped database | First attempts failed: (a) `CREATE SCHEMA public` already exists; (b) the definer-function ownership change needs `app`'s grants first; (c) Supabase's default privileges cannot be restored by the migrator. This led to **`scripts/db/restore-dump.sh`**, which handles all three |
| `restore-dump.sh`, as written, into a new bootstrapped database | **Row counts identical** (28 tables, 10,647 rows). `verify-supabase.sql` **10/10 t**. `crm_app` without a tenant sees **0** leads. **8 of 8** SECURITY DEFINER functions still owned by `crm_definer`. A second run **refuses** (exit 3) |

**Bootstrap password handling, rehearsed again (2026-10-26)** on a new disposable PostgreSQL 17.11 container, set up the same way, with `log_statement = ddl` for `supa_admin` as on Supabase. It used `--emit-sql` piped into psql in a separate container, with the passwords then read from the process environment. Since 2026-10-27 the helper reads them from `.env` (`ACCEPTANCE_*` only). The SQL and the transaction it sends are unchanged.

| Step | Result |
|---|---|
| Wrapper refusals (no database) | Missing variable, under 24 characters, duplicate passwords, local placeholder, wrong mode: all exit 1, naming only the variable |
| Failure: a conflicting `crm_app` role exists | Stops at that `CREATE ROLE`; **rolled back** (no `crm_*` role left); client output has no verifier and no password |
| Failure: `citext` already in another schema | Stops at the extension check; **rolled back** (no roles, no `uuidv7`); nothing secret in the output |
| SQL run directly with a plaintext value | Refused before any role is created; the value is not echoed |
| Bootstrap as `supa_admin` (not a superuser) | **OK**, exit 0. Six roles, none superuser, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Only membership: `crm_migrator` in `crm_definer`. Timeouts: app 10s/30s idle, auth 10s, platform 30s, cleanup 10s/30s idle with limit 2. Extensions in `public`. `uuidv7` compat, executable only by the CRM roles and the admin, not by `anon`, `authenticated` or `service_role` |
| Logins over SCRAM | All five roles log in with their passwords; a wrong password is refused (28P01). `pg_authid` holds SCRAM verifiers |
| `uuidv7()` as `crm_app` | 20,000 ids distinct, version 7, RFC variant, 0 out of order |
| Server log | **No plaintext password.** **12 lines contain verifiers:** the `CREATE ROLE` statements of every run, failed runs included, and one `STATEMENT:` error line. This was before the split and the logging guard below |

**Split bootstrap and logging guard, rehearsed (2026-10-27)** on two new disposable PostgreSQL 17 containers, using synthetic passwords only.
- **The servers were stricter than Supabase:** server-wide `log_statement = all`, `log_min_error_statement = error`, `pg_stat_statements` preloaded, and `pgaudit.log = ddl`.
- `pgaudit.log` was a placeholder setting, because the image has no pgaudit. That exercises the script's pgaudit branch, not pgaudit itself.
- The admin was either the superuser, standing in for Supabase's supautils elevation, or `supa_admin`, a plain non-superuser with CREATEROLE.

**30 of 30 checks passed:**

| Step | Result |
|---|---|
| A, roles and grants, guard on, as an admin that may set the parameters | **OK.** Six roles with no elevated attribute; grants and timeouts as documented; **no extension and no `uuidv7`**. **0** verifiers in the server log and **0** in `pg_stat_statements`. Server-wide settings unchanged afterwards (`all`, `on`, `ddl`) |
| A again, with different passwords | **OK.** All five verifiers unchanged, `crm_cleanup` included ("password unchanged"); still 0 in the log and 0 in `pg_stat_statements` |
| B, extensions and `uuidv7`, after A | **OK.** Three extensions in `public`; `uuidv7` compat, executable by `crm_app` and not by PUBLIC. No password or role count changed |
| B before A | **Refused** ("the CRM roles are missing"); nothing created |
| A, guard on, as plain `supa_admin` (may not set the parameters) | **Refused, fail-closed:** "permission denied to set parameter log_statement". No role, and **0** verifiers in the log or `pg_stat_statements`, because none was sent |
| A without a transaction (`SET LOCAL` cannot take effect) | **Refused** by the effective-value check before any verifier; 0 logged |
| A with `--allow-ddl-logging` (local rehearsal) as `supa_admin` | **OK.** That is the rehearsal path. Without the guard the verifiers **are** recorded: 10 log hits and 5 in `pg_stat_statements`. This shows the guard is what prevents it |
| B as `supa_admin` | **OK** |

A first run of this rehearsal also caught a wrapper bug: the `\set` lines lost their backslash, so psql variables reached the server as SQL. It was fixed before the 30/30 run, and `supabase-bootstrap.test.ts` now asserts that every verifier line is a client-side `\set`.

**Migrations 0001–0027, rehearsed (2026-11-11)** on a disposable `postgres:17-alpine` container (PostgreSQL 17.11), memory-only, removed afterwards, synthetic passwords only.
- `supa_admin`: NOSUPERUSER, CREATEROLE, CREATEDB, BYPASSRLS, owning the database and `public`; `anon`, `authenticated` and `service_role` with default privileges granting them ALL on tables, sequences and functions in `public`.

| Step | Result |
|---|---|
| Bootstrap steps A and B as `supa_admin` (`rolesScript`, `extensionsScript`) | **OK.** `uuidv7` = compat |
| All 27 migrations as `crm_migrator`, each in one transaction shaped like the wrapper's (advisory lock, `search_path = public`, marker table, unchanged SQL, marker row), then `prisma migrate resolve --applied` | **27 of 27 OK** |
| `verify-supabase.sql` read-only as `crm_migrator`, evaluated by the wrapper's `evaluateVerify` | **14 of 14 `ok = t`.** 44 application tables + marker = 45, all with RLS forced. **No** privilege for the API roles on any CRM table or function despite the permissive defaults. 11 SECURITY DEFINER functions, all owned by `crm_definer` |
| **Full integration project on this server** (`TEST_*` URLs pointed at it for that run only) | **48 files, 754/754** |

Not covered by this rehearsal: the wrapper's TLS paths (the container had no TLS; Prisma recorded through `prisma.config.ts`). Those were rehearsed on 2026-10-27/28 and are unchanged.

**Not proven by the rehearsal** (needs the real project):
- Supavisor itself;
- Supabase's exact privileges and event triggers;
- network latency;
- the pause behaviour;
- the Data API settings.
