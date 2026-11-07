-- Spike S2: identity tables under RLS. Runs as crm_migrator.
--
-- Roles
--   crm_auth      used only by Better Auth (auth tables + organization plugin tables)
--   crm_app       business code: tenant rows for app.org_id only (fail closed)
--   crm_platform  platform admin: organization list, platform audit, support-grant requests
--   crm_definer   owner of pre-tenant SECURITY DEFINER lookups (NOLOGIN)
--   crm_migrator  schema owner: maintenance policy only

CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO crm_app, crm_platform, crm_definer, crm_auth;
GRANT CREATE ON SCHEMA app TO crm_definer;

CREATE FUNCTION app.current_org_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION app.current_org_id(), app.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_org_id(), app.current_user_id()
  TO crm_app, crm_platform, crm_definer;

-- ---------------------------------------------------------------------------
-- Integrity
-- ---------------------------------------------------------------------------
-- Exactly one known role per membership/invitation (Better Auth allows comma lists).
ALTER TABLE organization_membership
  ADD CONSTRAINT organization_membership_single_role
    CHECK (role IN ('owner', 'admin', 'sales_manager', 'sales_executive', 'hr_ops')),
  ADD CONSTRAINT organization_membership_status
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'));
ALTER TABLE invitation
  ADD CONSTRAINT invitation_single_role
    CHECK (role IS NULL OR role IN ('owner', 'admin', 'sales_manager', 'sales_executive', 'hr_ops'));
ALTER TABLE support_access_grant
  ADD CONSTRAINT support_access_grant_level CHECK (access_level IN ('READ', 'WRITE')),
  ADD CONSTRAINT support_access_grant_window
    CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '72 hours');
ALTER TABLE "user"
  ADD CONSTRAINT user_platform_role CHECK (platform_role IS NULL OR platform_role = 'PLATFORM_ADMIN');

-- ---------------------------------------------------------------------------
-- RLS on every table (ENABLE + FORCE); migrator maintenance policy everywhere
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user', 'session', 'account', 'verification', 'two_factor', 'organization',
    'organization_membership', 'invitation', 'team', 'team_membership', 'lead',
    'support_access_grant', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY maintenance ON %I FOR ALL TO crm_migrator USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Tenant tables owned by our code: crm_app sees the current org only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organization_membership', 'invitation', 'team', 'team_membership', 'lead', 'support_access_grant'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO crm_app '
      'USING (org_id = (SELECT app.current_org_id())) '
      'WITH CHECK (org_id = (SELECT app.current_org_id()))', t);
  END LOOP;
END $$;

-- Authentication library: full access to its own tables, nothing else.
-- It must resolve users, sessions, memberships and invitations before any org context
-- exists, across orgs (e.g. "which orgs is this user in", "accept this invitation").
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user', 'session', 'account', 'verification', 'two_factor',
    'organization', 'organization_membership', 'invitation'
  ] LOOP
    EXECUTE format('CREATE POLICY auth_library ON %I FOR ALL TO crm_auth USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO crm_auth', t);
  END LOOP;
END $$;

-- user: own row, or members of the current org (as S1).
CREATE POLICY self_or_org_member_read ON "user" FOR SELECT TO crm_app
  USING (
    id = (SELECT app.current_user_id())
    OR EXISTS (
      SELECT 1 FROM organization_membership m
      WHERE m.user_id = "user".id AND m.org_id = (SELECT app.current_org_id())
    )
  );
GRANT SELECT (id, name, email, image, email_verified, two_factor_enabled, platform_role, created_at)
  ON "user" TO crm_app;

-- organization: current org for crm_app; all for the platform role.
CREATE POLICY current_org_read ON organization FOR SELECT TO crm_app
  USING (id = (SELECT app.current_org_id()));
CREATE POLICY platform_all ON organization FOR ALL TO crm_platform USING (true) WITH CHECK (true);
GRANT SELECT ON organization TO crm_app;
GRANT SELECT, INSERT, UPDATE ON organization TO crm_platform;

-- Membership/invitation writes go through the auth library (crm_auth); business code
-- reads them and may change membership status (suspend/deactivate).
GRANT SELECT, UPDATE (status) ON organization_membership TO crm_app;
GRANT SELECT ON invitation TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON team, team_membership, lead TO crm_app;

-- Support grants: requested by the platform, approved/revoked by the org owner (crm_app).
CREATE POLICY platform_requests ON support_access_grant FOR ALL TO crm_platform USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON support_access_grant TO crm_platform;
GRANT SELECT, UPDATE (approved_by_user_id, revoked_at) ON support_access_grant TO crm_app;

-- audit_log: org rows for crm_app; NULL-org rows for crm_platform; append-only.
CREATE POLICY tenant_isolation ON audit_log FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id())) WITH CHECK (org_id = (SELECT app.current_org_id()));
CREATE POLICY platform_rows ON audit_log FOR ALL TO crm_platform
  USING (org_id IS NULL) WITH CHECK (org_id IS NULL);
GRANT SELECT, INSERT ON audit_log TO crm_app, crm_platform;

-- ---------------------------------------------------------------------------
-- Pre-tenant definer functions
-- ---------------------------------------------------------------------------
CREATE POLICY definer_lookup ON organization_membership FOR SELECT TO crm_definer USING (true);
CREATE POLICY definer_lookup ON support_access_grant FOR SELECT TO crm_definer USING (true);
GRANT SELECT (id, org_id, user_id, role, status) ON organization_membership TO crm_definer;
GRANT SELECT (id, org_id, platform_user_id, access_level, approved_by_user_id, starts_at, expires_at, revoked_at)
  ON support_access_grant TO crm_definer;

CREATE FUNCTION app.auth_memberships_for_user(p_user_id uuid)
  RETURNS TABLE (org_id uuid, membership_id uuid, role_code text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.org_id, m.id, m.role, m.status
    FROM public.organization_membership m
    WHERE m.user_id = p_user_id AND p_user_id = app.current_user_id()
  $$;

-- Active, approved, unrevoked support grant for the calling platform user and org.
CREATE FUNCTION app.active_support_grant(p_org_id uuid)
  RETURNS TABLE (grant_id uuid, access_level text, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT g.id, g.access_level, g.expires_at
    FROM public.support_access_grant g
    WHERE g.org_id = p_org_id
      AND g.platform_user_id = app.current_user_id()
      AND g.approved_by_user_id IS NOT NULL
      AND g.revoked_at IS NULL
      AND now() >= g.starts_at AND now() < g.expires_at
  $$;

ALTER FUNCTION app.auth_memberships_for_user(uuid) OWNER TO crm_definer;
ALTER FUNCTION app.active_support_grant(uuid) OWNER TO crm_definer;
REVOKE ALL ON FUNCTION app.auth_memberships_for_user(uuid), app.active_support_grant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.auth_memberships_for_user(uuid), app.active_support_grant(uuid) TO crm_app;
