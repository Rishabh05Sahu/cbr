-- Step B of the Supabase bootstrap: the three extensions and public.uuidv7(), nothing else
-- (docs/runbooks/supabase-free-setup.md §4). Run as Supabase's `postgres` user, AFTER step A
-- (bootstrap-supabase.sql, which creates the roles this grants EXECUTE to), ONLY through:
--
--   node scripts/db/bootstrap-supabase.mjs --run-extensions
--
-- One transaction (the wrapper adds BEGIN/COMMIT). It creates no role, sends no password or
-- verifier, and changes no role attribute; it stops if the CRM roles are missing.
--
-- 1. citext, btree_gist and pg_trgm are created IN `public`, where the migrations resolve them
--    (as in local development). If Supabase already installed one in another schema (for
--    example `extensions`), the script stops instead of moving it.
-- 2. uuidv7(): built into PostgreSQL 18, which the migrations were written for. Supabase offers
--    17. On a server without it, public.uuidv7() is created: an RFC 9562 version-7 UUID
--    (48-bit Unix milliseconds, 12 bits of sub-millisecond time, random rest), used only as
--    the column default. On PostgreSQL 18 nothing is created.
-- 3. Supabase's API roles (anon, authenticated, service_role) and PUBLIC cannot execute it.

\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse
\set SHOW_CONTEXT never

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
SELECT count(*) = 5 AS roles_ok FROM pg_roles
 WHERE rolname IN ('crm_migrator', 'crm_app', 'crm_auth', 'crm_platform', 'crm_definer') \gset
\if :roles_ok
\else
  DO $$ BEGIN RAISE EXCEPTION 'the CRM roles are missing; run step A (bootstrap-supabase.mjs --run) first'; END $$;
\endif

-- Extensions in `public` (see 1.).
SELECT coalesce(string_agg(e.extname || ' (in ' || n.nspname || ')', ', '), '') AS misplaced
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname IN ('citext', 'btree_gist', 'pg_trgm') AND n.nspname <> 'public' \gset
SELECT :'misplaced' = '' AS ext_ok \gset
\if :ext_ok
\else
  \echo 'Already installed outside public:' :misplaced
  DO $$ BEGIN RAISE EXCEPTION 'move these extensions to schema public first (runbook §4), or ask for review'; END $$;
\endif
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- uuidv7() where the server lacks it (see 2.). Never replaces a function this script did not
-- create: an existing public.uuidv7() is kept only if it carries this script's comment, is plain
-- SQL returning uuid and belongs to no extension; anything else stops the script.
SELECT to_regprocedure('pg_catalog.uuidv7()') IS NULL AS need_uuidv7,
       to_regprocedure('public.uuidv7()') IS NOT NULL AS uuidv7_present,
       coalesce((SELECT p.prorettype = 'uuid'::regtype
                    AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'sql')
                    AND obj_description(p.oid, 'pg_proc') LIKE 'CRM: RFC 9562 UUIDv7 %'
                    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                     WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                                       AND d.deptype = 'e')
                   FROM pg_proc p WHERE p.oid = to_regprocedure('public.uuidv7()')), false)
         AS uuidv7_ours \gset
\if :need_uuidv7
\if :uuidv7_present
\if :uuidv7_ours
\echo 'public.uuidv7(): already created by this script; kept'
\else
  DO $$ BEGIN RAISE EXCEPTION 'public.uuidv7() already exists and was not created by this script; review it before continuing'; END $$;
\endif
\else
CREATE FUNCTION public.uuidv7() RETURNS uuid
  LANGUAGE sql VOLATILE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
  AS $$
    -- Bytes 0-5: Unix time in ms. Bytes 6-7: version 7 and 12 bits of sub-millisecond time
    -- (RFC 9562 §6.2 method 3, so ids from one session keep their order at microsecond
    -- resolution). Bytes 8-15: random, with the RFC variant bits from gen_random_uuid().
    SELECT encode(
      overlay(
        overlay(uuid_send(gen_random_uuid())
                placing substring(int8send(t.ms) from 3) from 1 for 6)
        placing int2send((28672 + t.sub)::smallint) from 7 for 2),
      'hex')::uuid
      FROM (SELECT floor(e * 1000)::bigint AS ms,
                   floor((e * 1000 - floor(e * 1000)) * 4096)::int AS sub
              FROM (SELECT extract(epoch FROM clock_timestamp()) AS e) x) t
  $$;
COMMENT ON FUNCTION public.uuidv7() IS
  'CRM: RFC 9562 UUIDv7 for servers before PostgreSQL 18 (scripts/db/bootstrap-supabase-extensions.sql)';
\endif
REVOKE ALL ON FUNCTION public.uuidv7() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.uuidv7() TO crm_migrator, crm_app, crm_auth, crm_platform, crm_definer;
\endif

-- Supabase's API roles get nothing on the function (see 3.). Done only where they exist, so the
-- script also runs on a plain PostgreSQL rehearsal.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
       AND to_regprocedure('public.uuidv7()') IS NOT NULL
       AND (SELECT p.pronamespace = 'public'::regnamespace FROM pg_proc p
             WHERE p.oid = to_regprocedure('public.uuidv7()')) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.uuidv7() FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Verification. Expect: the three extensions in public; uuidv7 either "built in" (PostgreSQL 18)
-- or "compat" with no grant to PUBLIC or the API roles.
SELECT e.extname, n.nspname AS schema FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname IN ('citext', 'btree_gist', 'pg_trgm') ORDER BY 1;
SELECT CASE WHEN to_regprocedure('pg_catalog.uuidv7()') IS NOT NULL THEN 'built in'
            WHEN to_regprocedure('public.uuidv7()') IS NOT NULL THEN 'compat' ELSE 'MISSING' END
         AS uuidv7,
       coalesce((SELECT array_to_string(proacl, ' ') FROM pg_proc
                  WHERE oid = to_regprocedure('public.uuidv7()')), '') AS uuidv7_acl;
