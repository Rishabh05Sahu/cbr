#!/bin/sh
# Restore a CRM dump (pg_dump --format=custom --schema=public --schema=app
# --enable-row-security, taken as crm_migrator) into a database that has ALREADY been bootstrapped
# with scripts/db/bootstrap-supabase.mjs (which includes crm_cleanup) and holds no CRM objects yet.
# Rehearsed on PostgreSQL 17 with a non-superuser admin (docs/runbooks/supabase-free-setup.md §8).
#
#   PGHOST=… PGPORT=… PGDATABASE=… PGUSER=crm_migrator PGPASSWORD=… sh scripts/db/restore-dump.sh crm.dump
#
# Connection settings come only from the PG* environment variables; nothing is printed but
# progress. Use pg_restore 17 or later (for example inside postgres:17-alpine).
#
# Why two steps and what is skipped:
# 1. Schema `app` and its grants first. The SECURITY DEFINER functions are handed to crm_definer
#    during the restore, which needs crm_definer's CREATE on `app`; pg_restore would otherwise
#    apply schema grants only at the end, and a non-superuser restore fails. (Restoring with
#    --no-owner is NOT an alternative: the definer functions would then run as crm_migrator.)
# 2. Everything else, except what belongs to the target platform or the bootstrap: the `public`
#    schema itself (Supabase's), public.uuidv7() (created by the bootstrap where the server lacks
#    it), and default privileges (Supabase's own, for its admin role; the migrations set none).
set -eu
dump="${1:?usage: restore-dump.sh <dump file>}"
[ "${PGUSER:-}" = crm_migrator ] || [ "${PGUSER#crm_migrator.}" != "$PGUSER" ] || {
  echo "restore-dump: run as crm_migrator (PGUSER)" >&2
  exit 2
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pg_restore -l "$dump" > "$tmp/all.list"
if psql -X -qtAc "SELECT 1 FROM pg_namespace WHERE nspname = 'app'" | grep -q 1; then
  echo "restore-dump: schema app already exists in the target; restore only into an empty, bootstrapped database" >&2
  exit 3
fi
grep -E 'SCHEMA - app |ACL - SCHEMA app ' "$tmp/all.list" > "$tmp/step1.list"
pg_restore --exit-on-error -d "${PGDATABASE:?PGDATABASE}" -L "$tmp/step1.list" "$dump"
grep -v -E 'SCHEMA - app |SCHEMA - public |COMMENT - SCHEMA public |ACL - SCHEMA public |uuidv7\(\)|DEFAULT ACL ' \
  "$tmp/all.list" > "$tmp/step2.list"
pg_restore --exit-on-error -d "$PGDATABASE" -L "$tmp/step2.list" "$dump"
echo "restore-dump: restored; now compare row counts with the source and run scripts/db/verify-supabase.sql"
