-- Phase 1 security layer. Runs as crm_migrator. Proven by spikes S1/S2
-- (docs/architecture/spikes). See prisma/README.md for the role model.
--
--   crm_app       web + worker business code: current org only (fail closed)
--   crm_auth      Better Auth only: auth + organisation/membership/invitation tables (D2)
--   crm_platform  platform console: organisations, platform audit, support-grant requests
--   crm_definer   NOLOGIN owner of pre-tenant SECURITY DEFINER functions
--   crm_migrator  schema owner: maintenance policy only; never used at runtime

-- ---------------------------------------------------------------------------
-- 1. Context helpers
-- ---------------------------------------------------------------------------
CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO crm_app, crm_platform, crm_definer;
GRANT CREATE ON SCHEMA app TO crm_definer;

-- '' after a transaction-local set_config ends, so nullif() keeps it fail-closed (S1 finding).
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
-- 2. Integrity
-- ---------------------------------------------------------------------------
ALTER TABLE organization
  ADD CONSTRAINT organization_status CHECK (status IN ('ACTIVE', 'SUSPENDED'));
ALTER TABLE organization_membership
  ADD CONSTRAINT organization_membership_single_role
    CHECK (role IN ('owner', 'admin', 'sales_manager', 'sales_executive', 'hr_ops')),
  ADD CONSTRAINT organization_membership_status
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'));
ALTER TABLE invitation
  ADD CONSTRAINT invitation_single_role
    CHECK (role IS NULL OR role IN ('owner', 'admin', 'sales_manager', 'sales_executive', 'hr_ops')),
  ADD CONSTRAINT invitation_status CHECK (status IN ('pending', 'accepted', 'rejected', 'canceled'));
ALTER TABLE "user"
  ADD CONSTRAINT user_platform_role CHECK (platform_role IS NULL OR platform_role = 'PLATFORM_ADMIN'),
  ADD CONSTRAINT user_phone_e164 CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE support_access_grant
  ADD CONSTRAINT support_access_grant_level CHECK (access_level IN ('READ', 'WRITE')),
  ADD CONSTRAINT support_access_grant_window
    CHECK (expires_at > starts_at AND expires_at <= starts_at + interval '72 hours');
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_kind CHECK (actor_kind IN ('USER', 'SYSTEM', 'PLATFORM'));
ALTER TABLE team_membership
  ADD CONSTRAINT team_membership_valid_range CHECK (ended_at IS NULL OR ended_at >= started_at);

-- One active team name per org (case-insensitive); one open spell per (team, member).
CREATE UNIQUE INDEX team_org_name_active_uq ON team (org_id, lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX team_membership_open_uq ON team_membership (team_id, membership_id) WHERE ended_at IS NULL;
CREATE INDEX outbox_event_pending_idx ON outbox_event (created_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. RLS: ENABLE + FORCE on every table, migrator maintenance policy
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user', 'session', 'account', 'verification', 'two_factor', 'organization',
    'organization_membership', 'invitation', 'team', 'team_membership',
    'support_access_grant', 'audit_log', 'outbox_event'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY maintenance ON %I FOR ALL TO crm_migrator USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Tenant tables: crm_app sees the current org only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organization_membership', 'invitation', 'team', 'team_membership',
    'support_access_grant', 'audit_log', 'outbox_event'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO crm_app '
      'USING (org_id = (SELECT app.current_org_id())) '
      'WITH CHECK (org_id = (SELECT app.current_org_id()))', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. crm_auth (D2): least privilege for the authentication library.
--    Intended cross-organisation access: Better Auth resolves users, sessions,
--    memberships and invitations before an org context exists (sign-in, active-org
--    switch, invitation acceptance). It has NO grants on teams, audit, outbox,
--    support grants or any CRM data, no BYPASSRLS, and cannot SET ROLE.
-- ---------------------------------------------------------------------------
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
GRANT USAGE ON SCHEMA public TO crm_auth;

-- ---------------------------------------------------------------------------
-- 5. crm_app grants and platform-scoped policies
-- ---------------------------------------------------------------------------
-- user: own row, or members of the current org; self-service profile edits only.
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
GRANT SELECT (id, name, email, image, email_verified, two_factor_enabled, platform_role, phone_e164, created_at)
  ON "user" TO crm_app;
GRANT UPDATE (name, phone_e164, updated_at) ON "user" TO crm_app;

-- organization: current org for crm_app (settings); all for the platform role.
CREATE POLICY current_org_read ON organization FOR SELECT TO crm_app
  USING (id = (SELECT app.current_org_id()));
CREATE POLICY current_org_update ON organization FOR UPDATE TO crm_app
  USING (id = (SELECT app.current_org_id())) WITH CHECK (id = (SELECT app.current_org_id()));
CREATE POLICY platform_all ON organization FOR ALL TO crm_platform USING (true) WITH CHECK (true);
GRANT SELECT ON organization TO crm_app;
GRANT UPDATE (name, time_zone, locale) ON organization TO crm_app;
GRANT SELECT, INSERT, UPDATE (name, status) ON organization TO crm_platform;

-- Membership/invitation writes go through Better Auth (crm_auth); our code reads them
-- and manages status and HR profile fields.
GRANT SELECT, UPDATE (status, suspended_at, employee_code, designation) ON organization_membership TO crm_app;
GRANT SELECT ON invitation TO crm_app;
GRANT SELECT, INSERT, UPDATE ON team, team_membership TO crm_app;
GRANT SELECT, INSERT ON outbox_event TO crm_app;

-- Support grants: requested by the platform, approved/revoked by the Owner (crm_app).
CREATE POLICY platform_requests ON support_access_grant FOR ALL TO crm_platform USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON support_access_grant TO crm_platform;
GRANT SELECT, UPDATE (approved_by_user_id, revoked_at) ON support_access_grant TO crm_app;

-- audit_log: org rows for crm_app; NULL-org rows for crm_platform; append-only for both.
CREATE POLICY platform_rows ON audit_log FOR ALL TO crm_platform
  USING (org_id IS NULL) WITH CHECK (org_id IS NULL);
GRANT SELECT, INSERT ON audit_log TO crm_app, crm_platform;

-- ---------------------------------------------------------------------------
-- 6. Pre-tenant SECURITY DEFINER functions (database-design §2.9)
-- ---------------------------------------------------------------------------
CREATE POLICY definer_lookup ON organization_membership FOR SELECT TO crm_definer USING (true);
CREATE POLICY definer_lookup ON organization FOR SELECT TO crm_definer USING (true);
CREATE POLICY definer_lookup ON support_access_grant FOR SELECT TO crm_definer USING (true);
CREATE POLICY definer_relay ON outbox_event FOR ALL TO crm_definer USING (true) WITH CHECK (true);
GRANT SELECT (id, org_id, user_id, role, status) ON organization_membership TO crm_definer;
GRANT SELECT (id, name, status, created_at) ON organization TO crm_definer;
GRANT SELECT (id, org_id, platform_user_id, access_level, approved_by_user_id, starts_at, expires_at, revoked_at)
  ON support_access_grant TO crm_definer;
GRANT SELECT (id, org_id, type, payload, created_at, claimed_until, attempts, published_at),
      UPDATE (claimed_until, attempts, published_at)
  ON outbox_event TO crm_definer;

-- Session -> memberships, for the authenticated user only (app.user_id).
CREATE FUNCTION app.auth_memberships_for_user(p_user_id uuid)
  RETURNS TABLE (org_id uuid, membership_id uuid, role_code text, status text, org_status text, org_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.org_id, m.id, m.role, m.status, o.status, o.name
    FROM public.organization_membership m
    JOIN public.organization o ON o.id = m.org_id
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

-- Outbox relay: claim a batch across orgs (SKIP LOCKED, lease), then mark published.
-- The relay only moves events to the queue; handlers re-enter withTenant(org_id).
CREATE FUNCTION app.outbox_claim(p_limit integer, p_lease_seconds integer DEFAULT 30)
  RETURNS TABLE (id uuid, org_id uuid, type text, payload jsonb, attempts integer)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    WITH c AS (
      SELECT e.id FROM public.outbox_event e
      WHERE e.published_at IS NULL AND (e.claimed_until IS NULL OR e.claimed_until < now())
      ORDER BY e.created_at
      LIMIT least(greatest(p_limit, 1), 500)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE public.outbox_event o
       SET claimed_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 5), 300)),
           attempts = o.attempts + 1
      FROM c WHERE o.id = c.id
    RETURNING o.id, o.org_id, o.type, o.payload, o.attempts
  $$;

CREATE FUNCTION app.outbox_mark_published(p_ids uuid[])
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    WITH u AS (
      UPDATE public.outbox_event SET published_at = now()
      WHERE id = ANY (p_ids) AND published_at IS NULL
      RETURNING 1
    ) SELECT count(*)::integer FROM u
  $$;

-- Platform console overview: org metadata and member counts only (no PII).
CREATE FUNCTION app.platform_org_overview()
  RETURNS TABLE (org_id uuid, name text, status text, created_at timestamptz, active_members bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT o.id, o.name, o.status, o.created_at,
           (SELECT count(*) FROM public.organization_membership m WHERE m.org_id = o.id AND m.status = 'ACTIVE')
    FROM public.organization o
    ORDER BY o.created_at DESC
  $$;

ALTER FUNCTION app.auth_memberships_for_user(uuid) OWNER TO crm_definer;
ALTER FUNCTION app.active_support_grant(uuid) OWNER TO crm_definer;
ALTER FUNCTION app.outbox_claim(integer, integer) OWNER TO crm_definer;
ALTER FUNCTION app.outbox_mark_published(uuid[]) OWNER TO crm_definer;
ALTER FUNCTION app.platform_org_overview() OWNER TO crm_definer;

REVOKE ALL ON FUNCTION
  app.auth_memberships_for_user(uuid), app.active_support_grant(uuid),
  app.outbox_claim(integer, integer), app.outbox_mark_published(uuid[]),
  app.platform_org_overview()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.auth_memberships_for_user(uuid), app.active_support_grant(uuid),
  app.outbox_claim(integer, integer), app.outbox_mark_published(uuid[])
  TO crm_app;
GRANT EXECUTE ON FUNCTION app.platform_org_overview() TO crm_platform;
