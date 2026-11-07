-- Provision crm_cleanup (Phase 2 M4): the worker's import-file cleanup role. Idempotent. Run
-- BEFORE migration 0005_imports (which grants it EXECUTE on app.import_files_due and fails if
-- the role is missing), once per database, as a role-admin user: `postgres` locally, the
-- provider's admin user on managed hosting (never the app, worker or migrator).
--
-- Do not run this file directly with a password. Use the wrapper, which computes a SCRAM-SHA-256
-- verifier from CRM_CLEANUP_PASSWORD on the client and feeds it in on stdin, so the plaintext
-- password never reaches the server, its logs, the process list or the terminal:
--
--   Local:   node scripts/db/provision-cleanup-role.mjs --local crm_test
--   Managed: node scripts/db/provision-cleanup-role.mjs --emit-sql \
--              | psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v db=crm -f -
--
-- Password handling: when a verifier is given, the role is created with it, or an existing role
-- is ALIGNED to it (ALTER ROLE ... PASSWORD <verifier>), so a stale password can never survive
-- silently. Without a verifier, an existing role keeps its password and a missing role is an
-- error. Anything that is not a SCRAM-SHA-256 verifier is refused, so plaintext is never sent.
--
-- What the role can do: connect to the database, resolve names in schema app, and execute
-- app.import_files_due (granted by migration 0005, nothing else). It has no table, column,
-- sequence or schema-create privilege, is a member of no role, inherits nothing, cannot bypass
-- RLS, and is limited to two connections.

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_cleanup') AS cleanup_exists \gset
\if :{?cleanup_verifier}
  SELECT :'cleanup_verifier' ~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
    AS verifier_ok \gset
  \if :verifier_ok
  \else
    DO $$ BEGIN RAISE EXCEPTION 'cleanup_verifier is not a SCRAM-SHA-256 verifier; use scripts/db/provision-cleanup-role.mjs'; END $$;
  \endif
  \if :cleanup_exists
    ALTER ROLE crm_cleanup PASSWORD :'cleanup_verifier';
    \echo 'crm_cleanup: existing role, password aligned to the configured value'
  \else
    CREATE ROLE crm_cleanup LOGIN PASSWORD :'cleanup_verifier'
      NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT CONNECTION LIMIT 2;
    \echo 'crm_cleanup: role created'
  \endif
\else
  \if :cleanup_exists
    \echo 'crm_cleanup: existing role, password unchanged (no verifier given)'
  \else
    DO $$ BEGIN RAISE EXCEPTION 'crm_cleanup does not exist; run scripts/db/provision-cleanup-role.mjs to create it'; END $$;
  \endif
\endif

-- Re-assert the attributes on every run (a role created earlier by hand is corrected).
-- SUPERUSER, BYPASSRLS and REPLICATION are checked, not set: since PostgreSQL 16 only a
-- superuser may name them in ALTER ROLE, and managed admins (Supabase's postgres, DigitalOcean's
-- doadmin, Neon) are not superusers. A role that has any of them stops the script.
ALTER ROLE crm_cleanup LOGIN NOCREATEROLE NOCREATEDB NOINHERIT CONNECTION LIMIT 2;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_cleanup'
               AND (rolsuper OR rolbypassrls OR rolreplication)) THEN
    RAISE EXCEPTION 'crm_cleanup must not be SUPERUSER, BYPASSRLS or REPLICATION; fix it as a superuser';
  END IF;
END $$;
ALTER ROLE crm_cleanup SET statement_timeout = '10s';
ALTER ROLE crm_cleanup SET idle_in_transaction_session_timeout = '30s';

GRANT CONNECT ON DATABASE :"db" TO crm_cleanup;

-- Verification. Expect one row: f|f|t|f|0 (not superuser, no BYPASSRLS, can log in, does not
-- inherit, no memberships).
SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin, r.rolinherit,
       (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
  FROM pg_roles r WHERE r.rolname = 'crm_cleanup';
