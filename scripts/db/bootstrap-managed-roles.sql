-- One-time bootstrap of CRM roles on a MANAGED PostgreSQL 18 cluster (staging/production).
-- Run as the provider's admin user (DigitalOcean: doadmin) against the target database:
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
--     -v db=crm -v migrator_pw="$CRM_MIGRATOR_PASSWORD" -v app_pw="$CRM_APP_PASSWORD" \
--     -v auth_pw="$CRM_AUTH_PASSWORD" -v platform_pw="$CRM_PLATFORM_PASSWORD" \
--     -f scripts/db/bootstrap-managed-roles.sql
--
-- Then, before migration 0005_imports, the import-file cleanup role (same admin user):
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v db=crm -v cleanup_pw="$CRM_CLEANUP_PASSWORD" \
--     -f scripts/db/provision-cleanup-role.sql
--
-- The admin user itself has BYPASSRLS on DigitalOcean and is NEVER used by the app, the worker
-- or migrations. Passwords come from the secret store; never commit them. Mirrors
-- docker/postgres/init/01-roles.sh. S1-18 verifies the result (docs/runbooks/staging-preparation.md).

-- Roles are cluster-wide: they are created on the first run only. Later runs (one per
-- database) only apply the per-database steps; passwords are then not changed.
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_migrator') AS create_roles \gset
\if :create_roles
CREATE ROLE crm_migrator LOGIN PASSWORD :'migrator_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE crm_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE crm_auth LOGIN PASSWORD :'auth_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE crm_platform LOGIN PASSWORD :'platform_pw' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE ROLE crm_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
GRANT crm_definer TO crm_migrator;
\endif

-- Runtime limits (database-design §8).
ALTER ROLE crm_app SET statement_timeout = '10s';
ALTER ROLE crm_auth SET statement_timeout = '10s';
ALTER ROLE crm_platform SET statement_timeout = '30s';
ALTER ROLE crm_app SET idle_in_transaction_session_timeout = '30s';

\connect :"db"
-- Everything below runs while the admin still owns the new database (it created it): a
-- non-owner's REVOKE/GRANT on the database only raises a warning and changes nothing, and
-- CREATE EXTENSION needs CREATE on the database. Ownership is handed over last.
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO crm_migrator, crm_app, crm_auth, crm_platform;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO crm_app, crm_platform, crm_auth, crm_definer;

-- PostgreSQL 16+: a non-superuser admin (DigitalOcean's doadmin) can hand ownership to a role
-- only while it may SET ROLE to it. Temporary SET-only membership (no inherited privileges),
-- revoked straight after. crm_migrator gains nothing from it.
GRANT crm_migrator TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
ALTER SCHEMA public OWNER TO crm_migrator;
ALTER DATABASE :"db" OWNER TO crm_migrator;
REVOKE crm_migrator FROM CURRENT_USER;

-- Verification. Expect:
--   * no crm_* role with rolsuper or rolbypassrls = t;
--   * public_can_connect = f;
--   * admin_memberships_left = 1 and admin_only = 1 (shown as "1|1"). The temporary SET-only
--     grant above is gone, but PostgreSQL 16+ automatically gives a non-superuser CREATEROLE
--     admin (doadmin, neondb_owner) one membership in every role it creates: ADMIN OPTION only,
--     INHERIT FALSE, SET FALSE (createrole_self_grant is empty). It is in the direction
--     "admin is a member of crm_*", so the admin can later ALTER/DROP the roles; it gives the
--     admin no privileges of the role and gives the crm_* roles nothing. It cannot be revoked by
--     the admin itself (the bootstrap superuser granted it). A superuser admin (local only) has
--     none: "0|0". Any other value, or any membership of a crm_* role in another role apart from
--     crm_migrator in crm_definer, is wrong (checked by scripts/managed-db/s1-report.mjs).
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'crm_%' ORDER BY 1;
SELECT datname, pg_get_userbyid(datdba) AS owner, datacl FROM pg_database WHERE datname = :'db';
SELECT has_database_privilege('public', :'db', 'CONNECT') AS public_can_connect;
SELECT count(*) AS admin_memberships_left,
       count(*) FILTER (WHERE m.admin_option AND NOT m.inherit_option AND NOT m.set_option) AS admin_only
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = 'crm_migrator' AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user);
