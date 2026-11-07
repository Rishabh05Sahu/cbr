#!/bin/bash
# Creates the CRM database roles and local databases on first container start.
# Mirrors database-design.md §2.4. Local development only.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<SQL
-- Schema owner; runs migrations. Not used by the running app.
CREATE ROLE crm_migrator LOGIN PASSWORD '${CRM_MIGRATOR_PASSWORD}'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
-- Runtime role for web and worker: owns nothing, subject to RLS.
CREATE ROLE crm_app LOGIN PASSWORD '${CRM_APP_PASSWORD}'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
-- Platform-admin queries (organization list, platform audit). No tenant PII grants.
CREATE ROLE crm_platform LOGIN PASSWORD '${CRM_PLATFORM_PASSWORD}'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
-- Used only by the authentication library (Better Auth) for its own tables
-- (user, session, account, verification, two_factor, organization, membership, invitation).
-- Business code never uses it (lint rule); see spikes/s2-identity/README.md.
CREATE ROLE crm_auth LOGIN PASSWORD '${CRM_AUTH_PASSWORD}'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
-- Owner of SECURITY DEFINER pre-tenant lookup functions. Cannot log in.
CREATE ROLE crm_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

-- The migrator must be able to hand function ownership to crm_definer.
GRANT crm_definer TO crm_migrator;

CREATE DATABASE crm_dev OWNER crm_migrator;
CREATE DATABASE crm_s1 OWNER crm_migrator;
CREATE DATABASE crm_s2 OWNER crm_migrator;
CREATE DATABASE crm_test OWNER crm_migrator;
SQL

for db in crm_dev crm_test crm_s1 crm_s2; do
psql -v ON_ERROR_STOP=1 --username postgres --dbname "$db" <<SQL
REVOKE ALL ON DATABASE $db FROM PUBLIC;
GRANT CONNECT ON DATABASE $db TO crm_app, crm_platform, crm_auth;
-- Extensions need superuser locally; on managed hosting they are enabled by the admin user.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER SCHEMA public OWNER TO crm_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO crm_app, crm_platform, crm_auth, crm_definer;
SQL
done

# Import-file cleanup role (Phase 2 M4, migration 0005_imports). On a fresh volume the role is
# created here like the roles above (server-side hashing during initdb); the shared script then
# applies the attributes and the per-database grant. Skipped when CRM_CLEANUP_PASSWORD is unset:
# run `node scripts/db/provision-cleanup-role.mjs --local <db>` later (0005 fails until then).
if [ -n "${CRM_CLEANUP_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<SQL
CREATE ROLE crm_cleanup LOGIN PASSWORD '${CRM_CLEANUP_PASSWORD}'
  NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION NOINHERIT CONNECTION LIMIT 2;
SQL
  for db in crm_dev crm_test; do
    psql -v ON_ERROR_STOP=1 --username postgres --dbname "$db" -v db="$db" -f /crm-sql/provision-cleanup-role.sql
  done
else
  echo "01-roles.sh: CRM_CLEANUP_PASSWORD not set; crm_cleanup not created" >&2
fi
