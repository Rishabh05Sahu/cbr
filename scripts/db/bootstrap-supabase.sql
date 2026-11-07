-- Step A of the Supabase bootstrap: the CRM ROLES and their grants, nothing else
-- (docs/runbooks/supabase-free-setup.md §4). Run as Supabase's `postgres` user through the
-- session pooler, ONLY through the wrapper:
--
--   node scripts/db/bootstrap-supabase.mjs --run
--
-- Step B (extensions and public.uuidv7(), bootstrap-supabase-extensions.sql, `--run-extensions`)
-- and the migrations are separate, separately approved steps. This file creates no schema,
-- table, extension or function.
--
-- The wrapper reads the ACCEPTANCE_-prefixed variables of .env only, computes a SCRAM-SHA-256
-- verifier for each login role on the client, sets them as psql variables on stdin (never argv,
-- never a file), runs psql 17 in a throwaway container, appends provision-cleanup-role.sql for
-- crm_cleanup, and wraps everything in one transaction. Plaintext passwords are refused here.
--
-- Verifiers are credentials. Two server-side places would keep them: the server log (Supabase
-- sets log_statement = ddl for `postgres`) and pg_stat_statements (it stores CREATE/ALTER ROLE
-- text verbatim, verifier included; verified on PostgreSQL 17). With quiet_ddl (the wrapper's
-- default) the transaction first switches both off FOR ITSELF ONLY (SET LOCAL; nothing
-- persistent changes), then checks the effective values and stops before any verifier is sent
-- if one is not off. On Supabase the postgres role may SET these through supautils
-- (privileged_role_allowed_configs); if it may not, the SET fails and nothing is applied.
--
-- Same six-role model and the same attributes as scripts/db/bootstrap-managed-roles.sql
-- (database-design §2.4). No ownership transfer: Supabase's own services (Auth, Storage, the
-- Data API) live in the same `postgres` database and use the `public` schema, so the database
-- and schema stay Supabase's. Instead crm_migrator gets CREATE on the database (migration 0002
-- creates schema `app`) and USAGE, CREATE on `public` (the CRM tables and `_prisma_migrations`).
-- Supabase's API roles (anon, authenticated, service_role) get nothing here. No role gets
-- SUPERUSER or BYPASSRLS; RLS and every policy come from the migrations unchanged.

\set ON_ERROR_STOP on
-- No statement text in error output (a failed CREATE ROLE would otherwise echo its verifier).
\set ECHO none
\set VERBOSITY terse
\set SHOW_CONTEXT never

\if :{?quiet_ddl}
\else
  DO $$ BEGIN RAISE EXCEPTION 'quiet_ddl not set; run this file only through scripts/db/bootstrap-supabase.mjs'; END $$;
\endif

-- Before ANY statement that carries a verifier (the format check below included).
\if :quiet_ddl
SET LOCAL log_statement = 'none';
SET LOCAL log_min_duration_statement = -1;
SET LOCAL log_min_error_statement = 'panic';
SELECT current_setting('pgaudit.log', true) IS NOT NULL AS pgaudit_loaded,
       current_setting('pg_stat_statements.track_utility', true) IS NOT NULL AS pgss_loaded \gset
\if :pgaudit_loaded
SET LOCAL pgaudit.log = 'none';
\endif
\if :pgss_loaded
SET LOCAL pg_stat_statements.track_utility = off;
\endif
-- Effective values, plus the ones that cannot be SET here but would also log statement text.
-- A SET LOCAL outside a transaction does not stick, so this also proves the transaction.
SELECT current_setting('log_statement') = 'none'
   AND current_setting('log_min_duration_statement') = '-1'
   AND current_setting('log_min_error_statement') = 'panic'
   AND current_setting('log_min_duration_sample') = '-1'
   AND current_setting('log_transaction_sample_rate')::float8 = 0
   AND current_setting('debug_print_parse') = 'off'
   AND current_setting('debug_print_rewritten') = 'off'
   AND current_setting('debug_print_plan') = 'off'
   AND coalesce(current_setting('pgaudit.log', true), 'none') = 'none'
   AND coalesce(current_setting('pg_stat_statements.track_utility', true), 'off') = 'off'
   AS quiet_ok \gset
\if :quiet_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'statement logging could not be switched off for this transaction; nothing sent, nothing applied'; END $$;
\endif
\else
\warn 'bootstrap-supabase: quiet_ddl off: role verifiers may be logged (local rehearsal only)'
\endif

-- Only SCRAM-SHA-256 verifiers are accepted, never plaintext (see the header).
SELECT :{?migrator_verifier} AND :{?app_verifier} AND :{?auth_verifier} AND :{?platform_verifier}
  AS verifiers_given \gset
\if :verifiers_given
\else
  DO $$ BEGIN RAISE EXCEPTION 'role verifiers missing; run this file only through scripts/db/bootstrap-supabase.mjs'; END $$;
\endif
SELECT bool_and(v ~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$')
  AS verifiers_ok
  FROM (VALUES (:'migrator_verifier'), (:'app_verifier'), (:'auth_verifier'),
               (:'platform_verifier')) t(v) \gset
\if :verifiers_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'a role verifier is not a SCRAM-SHA-256 verifier; use scripts/db/bootstrap-supabase.mjs'; END $$;
\endif

SELECT current_setting('server_version_num')::int >= 170000 AS server_ok \gset
\if :server_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'PostgreSQL 17 or later is required'; END $$;
\endif
SELECT current_database() = :'db' AS db_ok \gset
\if :db_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'connected to the wrong database (pass -v db=<the target>)'; END $$;
\endif

-- Roles (cluster-wide): created on the first run only; later runs keep the passwords. The
-- wrapper's single transaction means a failed first run leaves no role behind.
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_migrator') AS create_roles \gset
\if :create_roles
CREATE ROLE crm_migrator LOGIN PASSWORD :'migrator_verifier' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE crm_app LOGIN PASSWORD :'app_verifier' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE crm_auth LOGIN PASSWORD :'auth_verifier' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE crm_platform LOGIN PASSWORD :'platform_verifier' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE crm_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
GRANT crm_definer TO crm_migrator;
\endif

-- Runtime limits (database-design §8).
ALTER ROLE crm_app SET statement_timeout = '10s';
ALTER ROLE crm_auth SET statement_timeout = '10s';
ALTER ROLE crm_platform SET statement_timeout = '30s';
ALTER ROLE crm_app SET idle_in_transaction_session_timeout = '30s';

-- Database and schema privileges (no ownership change, see the header).
GRANT CONNECT ON DATABASE :"db" TO crm_migrator, crm_app, crm_auth, crm_platform;
GRANT CREATE ON DATABASE :"db" TO crm_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO crm_migrator;
GRANT USAGE ON SCHEMA public TO crm_app, crm_platform, crm_auth, crm_definer;

-- crm_cleanup (provision-cleanup-role.sql, appended by the wrapper): on a rerun, keep its
-- password like the four above instead of re-sending a verifier.
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_cleanup') AS cleanup_present \gset
\if :cleanup_present
\unset cleanup_verifier
\endif

-- Verification. Expect: no crm_* role with rolsuper or rolbypassrls.
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit
  FROM pg_roles WHERE rolname LIKE 'crm\_%' ORDER BY 1;
SELECT has_database_privilege('crm_migrator', :'db', 'CREATE') AS migrator_can_create_schema,
       has_schema_privilege('crm_migrator', 'public', 'CREATE') AS migrator_can_create_in_public;
