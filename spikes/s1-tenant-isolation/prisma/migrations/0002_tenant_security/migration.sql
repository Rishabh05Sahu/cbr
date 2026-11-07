-- Spike S1: tenant-isolation controls that Prisma's schema language cannot express.
-- Implements database-design.md §2 (points 1–10). Runs as crm_migrator.
--
-- Policy model
--   crm_app       runtime role: tenant rows only where org_id = app.org_id (fail closed)
--   crm_platform  platform admin: organization list + platform audit rows only
--   crm_definer   owner of SECURITY DEFINER pre-tenant lookups: column-limited SELECT
--   crm_migrator  schema owner: maintenance policy (it could disable RLS anyway as owner;
--                 it is never used by the running app)

-- ---------------------------------------------------------------------------
-- 1. Context helpers
-- ---------------------------------------------------------------------------
CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO crm_app, crm_platform, crm_definer;
-- crm_definer must own functions in this schema (ALTER FUNCTION ... OWNER).
GRANT CREATE ON SCHEMA app TO crm_definer;

-- NULL when unset. After a transaction-local set_config() ends, PostgreSQL reports the
-- placeholder as '' rather than NULL, so nullif() is required for fail-closed behaviour.
CREATE FUNCTION app.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

REVOKE ALL ON FUNCTION app.current_org_id(), app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_org_id(), app.current_user_id()
  TO crm_app, crm_platform, crm_definer;

-- ---------------------------------------------------------------------------
-- 2. Integrity constraints
-- ---------------------------------------------------------------------------
ALTER TABLE lead_assignment_history
  ADD CONSTRAINT lead_assignment_history_valid_range
    CHECK (ended_at IS NULL OR ended_at > started_at),
  ADD CONSTRAINT lead_assignment_history_no_overlap
    EXCLUDE USING gist (org_id WITH =, lead_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&);

ALTER TABLE delegation
  ADD CONSTRAINT delegation_valid_range CHECK (ends_at > starts_at);

-- ---------------------------------------------------------------------------
-- 3. Tenant tables: ENABLE + FORCE RLS, one tenant policy for crm_app
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organization_membership', 'team', 'team_membership', 'lead', 'lead_assignment_history',
    'delegation', 'task', 'interaction', 'import_job', 'import_row',
    'integration_connection', 'share_link', 'invitation'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I AS PERMISSIVE FOR ALL TO crm_app '
      'USING (org_id = (SELECT app.current_org_id())) '
      'WITH CHECK (org_id = (SELECT app.current_org_id()))', t);
    EXECUTE format(
      'CREATE POLICY maintenance ON %I FOR ALL TO crm_migrator USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  organization_membership, team, team_membership, lead, delegation, task, interaction,
  import_job, import_row, integration_connection, share_link, invitation
  TO crm_app;

-- Assignment history is append-only for the app, except closing a spell once.
GRANT SELECT, INSERT ON lead_assignment_history TO crm_app;
GRANT UPDATE (ended_at) ON lead_assignment_history TO crm_app;

-- ---------------------------------------------------------------------------
-- 4. Platform-scoped tables (database-design.md §2.10)
-- ---------------------------------------------------------------------------
-- organization: the app sees only its current org; the platform role lists all orgs.
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
CREATE POLICY current_org_read ON organization FOR SELECT TO crm_app
  USING (id = (SELECT app.current_org_id()));
CREATE POLICY current_org_update ON organization FOR UPDATE TO crm_app
  USING (id = (SELECT app.current_org_id())) WITH CHECK (id = (SELECT app.current_org_id()));
CREATE POLICY platform_all ON organization FOR ALL TO crm_platform USING (true) WITH CHECK (true);
CREATE POLICY maintenance ON organization FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE (name) ON organization TO crm_app;
GRANT SELECT, INSERT, UPDATE ON organization TO crm_platform;

-- user: a user reads their own row, plus users who are members of the current org
-- (domain-model: "users are visible to an org only through memberships").
-- The membership sub-select is itself filtered by the tenant policy.
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;
CREATE POLICY self_or_org_member_read ON "user" FOR SELECT TO crm_app
  USING (
    id = (SELECT app.current_user_id())
    OR EXISTS (
      SELECT 1 FROM organization_membership m
      WHERE m.user_id = "user".id AND m.org_id = (SELECT app.current_org_id())
    )
  );
CREATE POLICY self_update ON "user" FOR UPDATE TO crm_app
  USING (id = (SELECT app.current_user_id())) WITH CHECK (id = (SELECT app.current_user_id()));
CREATE POLICY maintenance ON "user" FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE (name) ON "user" TO crm_app;

-- audit_log: org rows for the app; NULL-org (platform) rows only for crm_platform. Append-only.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
CREATE POLICY platform_rows ON audit_log FOR ALL TO crm_platform
  USING (org_id IS NULL) WITH CHECK (org_id IS NULL);
CREATE POLICY maintenance ON audit_log FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON audit_log TO crm_app, crm_platform;

-- ---------------------------------------------------------------------------
-- 5. Pre-tenant lookups (database-design.md §2.9)
--    Owned by crm_definer (NOLOGIN), fixed search_path, exact-match only,
--    minimum columns. crm_definer gets column-limited SELECT via its own policies.
-- ---------------------------------------------------------------------------
CREATE POLICY definer_lookup ON organization_membership FOR SELECT TO crm_definer USING (true);
CREATE POLICY definer_lookup ON integration_connection FOR SELECT TO crm_definer USING (true);
CREATE POLICY definer_lookup ON share_link FOR SELECT TO crm_definer USING (true);
CREATE POLICY definer_lookup ON invitation FOR SELECT TO crm_definer USING (true);
GRANT SELECT (id, org_id, user_id, role_code, status) ON organization_membership TO crm_definer;
GRANT SELECT (id, org_id, provider, webhook_token_hash) ON integration_connection TO crm_definer;
GRANT SELECT (id, org_id, token_hash, expires_at) ON share_link TO crm_definer;
GRANT SELECT (id, org_id, email, status, expires_at, token_hash) ON invitation TO crm_definer;

-- Session -> memberships. Only for the user the app has already authenticated
-- (app.user_id), so it cannot be used to look up someone else's orgs.
CREATE FUNCTION app.auth_memberships_for_user(p_user_id uuid)
  RETURNS TABLE (org_id uuid, membership_id uuid, role_code membership_role, status membership_status)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.org_id, m.id, m.role_code, m.status
    FROM public.organization_membership m
    WHERE m.user_id = p_user_id
      AND p_user_id = app.current_user_id()
  $$;

CREATE FUNCTION app.resolve_webhook_connection(p_token_hash text)
  RETURNS TABLE (org_id uuid, connection_id uuid, provider text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT c.org_id, c.id, c.provider
    FROM public.integration_connection c
    WHERE c.webhook_token_hash = p_token_hash
  $$;

CREATE FUNCTION app.resolve_share_token(p_token_hash text)
  RETURNS TABLE (org_id uuid, share_id uuid, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT s.org_id, s.id, s.expires_at
    FROM public.share_link s
    WHERE s.token_hash = p_token_hash
  $$;

CREATE FUNCTION app.resolve_invitation(p_token_hash text)
  RETURNS TABLE (org_id uuid, invitation_id uuid, email citext, status text, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT i.org_id, i.id, i.email, i.status, i.expires_at
    FROM public.invitation i
    WHERE i.token_hash = p_token_hash
  $$;

ALTER FUNCTION app.auth_memberships_for_user(uuid) OWNER TO crm_definer;
ALTER FUNCTION app.resolve_webhook_connection(text) OWNER TO crm_definer;
ALTER FUNCTION app.resolve_share_token(text) OWNER TO crm_definer;
ALTER FUNCTION app.resolve_invitation(text) OWNER TO crm_definer;

REVOKE ALL ON FUNCTION
  app.auth_memberships_for_user(uuid), app.resolve_webhook_connection(text),
  app.resolve_share_token(text), app.resolve_invitation(text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.auth_memberships_for_user(uuid), app.resolve_webhook_connection(text),
  app.resolve_share_token(text), app.resolve_invitation(text)
  TO crm_app;
