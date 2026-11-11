-- Read-only checks after migrations 0001-0027 on the Supabase pilot database (runbook
-- docs/runbooks/supabase-free-setup.md §6). Run ONLY through the wrapper, as crm_migrator (it owns
-- the CRM objects), with strict TLS and inside a READ ONLY transaction that is rolled back:
--
--   node scripts/db/migrate-supabase.mjs --verify
--
-- One SELECT over the catalogs and the privilege functions; it changes nothing (the wrapper also
-- scans this file for anything that could write before running it). Prints one row per check,
-- "n|item|ok|detail"; the wrapper requires every check 1-14 exactly once with ok = t. A check
-- that cannot run (for example a missing schema) makes psql fail, which is a failure, never a pass.

\set ON_ERROR_STOP on

WITH app_tables AS (
  SELECT c.oid, n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'app')
     AND pg_get_userbyid(c.relowner) = 'crm_migrator'
     AND c.relname NOT IN ('_prisma_migrations', '_crm_migration_marker')
), marker AS (
  SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c WHERE c.oid = to_regclass('public._crm_migration_marker')
), crm_tables AS (
  SELECT oid, relname, relrowsecurity, relforcerowsecurity FROM app_tables
  UNION ALL SELECT oid, relname, relrowsecurity, relforcerowsecurity FROM marker
), api_roles AS (
  SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
), crm_roles AS (
  SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'crm\_%'
), crm_functions AS (
  SELECT p.oid, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig
    FROM pg_proc p
   WHERE p.pronamespace = to_regnamespace('app')
      OR p.oid = coalesce(to_regprocedure('public.uuidv7()'), 0)
), ledger AS (
  SELECT migration_name, finished_at IS NOT NULL AND rolled_back_at IS NULL AS applied
    FROM public._prisma_migrations
), checks AS (
  SELECT 1 AS n, 'migrations: exactly 0001-0027 applied, no other ledger entries' AS item,
         (SELECT count(*) FILTER (WHERE applied) || ' applied of ' || count(*) FROM ledger) AS detail,
         (SELECT count(*) FROM ledger) = 27
           AND (SELECT count(*) FROM ledger WHERE applied AND migration_name IN (
                  '0001_foundation', '0002_security', '0003_leads',
                  '0004_assignment', '0005_imports', '0006_hygiene',
                  '0007_lead_email_normalized', '0008_lead_name_sort_index', '0009_import_mapping_templates',
                  '0010_import_finished_notification', '0011_lead_tags', '0012_follow_ups',
                  '0013_follow_up_lifecycle', '0014_call_scripts', '0015_contact_status',
                  '0016_phone_masking', '0017_interactions', '0018_interaction_fingerprint',
                  '0019_interaction_script_version', '0020_task_types', '0021_task_assignment',
                  '0022_meeting_details', '0023_task_reminders', '0024_task_series',
                  '0025_properties', '0026_site_visits', '0027_site_visit_dnc_guard')) = 27 AS ok
  UNION ALL
  SELECT 2, 'application tables: exactly 44 owned by crm_migrator in public/app',
         (SELECT count(*) FROM app_tables)::text, (SELECT count(*) FROM app_tables) = 44
  UNION ALL
  SELECT 3, 'migration marker table: present, owned by crm_migrator',
         coalesce((SELECT owner FROM marker), 'missing'),
         coalesce((SELECT owner = 'crm_migrator' FROM marker), false)
  UNION ALL
  SELECT 4, 'every CRM table (44 + marker = 45): RLS enabled and forced',
         (SELECT count(*) FROM crm_tables)::text || ' tables; not forced: '
           || coalesce((SELECT string_agg(relname, ',') FROM crm_tables
                         WHERE NOT (relrowsecurity AND relforcerowsecurity)), 'none'),
         (SELECT count(*) FROM crm_tables) = 45
           AND NOT EXISTS (SELECT 1 FROM crm_tables WHERE NOT (relrowsecurity AND relforcerowsecurity))
  UNION ALL
  SELECT 5, 'API roles exist (anon, authenticated, service_role), so checks 6-8 are not vacuous',
         (SELECT count(*) FROM api_roles)::text, (SELECT count(*) FROM api_roles) = 3
  UNION ALL
  SELECT 6, 'API roles and PUBLIC: no table or column privilege on any CRM table',
         coalesce((SELECT string_agg(DISTINCT r.rolname || ' on ' || t.relname, ', ')
                     FROM crm_tables t
                     CROSS JOIN (SELECT oid, rolname FROM api_roles UNION ALL SELECT 0, 'PUBLIC') r
                    WHERE has_table_privilege(CASE WHEN r.oid = 0 THEN 'public' ELSE r.rolname END, t.oid,
                            'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                       OR has_any_column_privilege(CASE WHEN r.oid = 0 THEN 'public' ELSE r.rolname END, t.oid,
                            'SELECT, INSERT, UPDATE, REFERENCES')), 'none'),
         NOT EXISTS (SELECT 1 FROM crm_tables t
                      CROSS JOIN (SELECT oid, rolname FROM api_roles UNION ALL SELECT 0, 'PUBLIC') r
                     WHERE has_table_privilege(CASE WHEN r.oid = 0 THEN 'public' ELSE r.rolname END, t.oid,
                             'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                        OR has_any_column_privilege(CASE WHEN r.oid = 0 THEN 'public' ELSE r.rolname END, t.oid,
                             'SELECT, INSERT, UPDATE, REFERENCES'))
  UNION ALL
  SELECT 7, 'API roles: no EXECUTE on CRM functions (schema app, public.uuidv7)',
         coalesce((SELECT string_agg(DISTINCT a.rolname || ' on ' || f.oid::regprocedure::text, ', ')
                     FROM crm_functions f CROSS JOIN api_roles a
                    WHERE has_function_privilege(a.oid, f.oid, 'EXECUTE')), 'none'),
         NOT EXISTS (SELECT 1 FROM crm_functions f CROSS JOIN api_roles a
                      WHERE has_function_privilege(a.oid, f.oid, 'EXECUTE'))
  UNION ALL
  SELECT 8, 'API roles: no USAGE on schema app',
         coalesce((SELECT string_agg(rolname, ',') FROM api_roles
                    WHERE has_schema_privilege(oid, 'app', 'USAGE')), 'none'),
         NOT EXISTS (SELECT 1 FROM api_roles WHERE has_schema_privilege(oid, 'app', 'USAGE'))
  UNION ALL
  SELECT 9, 'no crm_* role is superuser or bypasses RLS',
         coalesce((SELECT string_agg(rolname, ',') FROM crm_roles WHERE rolsuper OR rolbypassrls), 'none'),
         NOT EXISTS (SELECT 1 FROM crm_roles WHERE rolsuper OR rolbypassrls)
  UNION ALL
  SELECT 10, 'exactly the six crm_* roles exist',
         (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM crm_roles),
         (SELECT array_agg(rolname ORDER BY rolname) FROM crm_roles)
           = ARRAY['crm_app', 'crm_auth', 'crm_cleanup', 'crm_definer', 'crm_migrator', 'crm_platform']::name[]
  UNION ALL
  SELECT 11, 'uuidv7: crm_app may execute it; PUBLIC may not (compat function)',
         CASE WHEN to_regprocedure('pg_catalog.uuidv7()') IS NOT NULL THEN 'built in'
              WHEN to_regprocedure('public.uuidv7()') IS NOT NULL THEN 'compat' ELSE 'MISSING' END,
         coalesce(has_function_privilege('crm_app', coalesce(to_regprocedure('pg_catalog.uuidv7()'),
                                                             to_regprocedure('public.uuidv7()')), 'EXECUTE'), false)
           AND (to_regprocedure('pg_catalog.uuidv7()') IS NOT NULL
                OR NOT has_function_privilege('public', to_regprocedure('public.uuidv7()'), 'EXECUTE'))
  UNION ALL
  SELECT 12, 'extensions citext, btree_gist, pg_trgm in public',
         coalesce((SELECT string_agg(e.extname || '@' || n.nspname, ',' ORDER BY e.extname) FROM pg_extension e
                     JOIN pg_namespace n ON n.oid = e.extnamespace
                    WHERE e.extname IN ('citext', 'btree_gist', 'pg_trgm')), 'none'),
         (SELECT count(*) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
           WHERE e.extname IN ('citext', 'btree_gist', 'pg_trgm') AND n.nspname = 'public') = 3
  UNION ALL
  SELECT 13, 'schema app: present, owned by crm_migrator',
         coalesce((SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'app'), 'missing'),
         coalesce((SELECT pg_get_userbyid(nspowner) = 'crm_migrator' FROM pg_namespace WHERE nspname = 'app'), false)
  UNION ALL
  SELECT 14, 'SECURITY DEFINER functions in app: exactly 11, owned by crm_definer, fixed search_path, not executable by PUBLIC',
         (SELECT count(*) FROM crm_functions WHERE prosecdef)::text || ' definer; wrong: '
           || coalesce((SELECT string_agg(oid::regprocedure::text, ', ') FROM crm_functions
                         WHERE prosecdef AND (owner <> 'crm_definer'
                           OR NOT coalesce(proconfig::text LIKE '%search_path=pg_catalog, pg_temp%', false)
                           OR has_function_privilege('public', oid, 'EXECUTE'))), 'none'),
         (SELECT count(*) FROM crm_functions WHERE prosecdef) = 11
           AND NOT EXISTS (SELECT 1 FROM crm_functions
                            WHERE prosecdef AND (owner <> 'crm_definer'
                              OR NOT coalesce(proconfig::text LIKE '%search_path=pg_catalog, pg_temp%', false)
                              OR has_function_privilege('public', oid, 'EXECUTE')))
)
SELECT n, item, ok, detail FROM checks ORDER BY n;
