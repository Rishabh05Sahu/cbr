-- FR-119 phone notifications for the Android app (ADR-0027 slice 5). One row per phone that
-- receives push notifications: the Firebase Cloud Messaging (FCM) registration token, the
-- member it belongs to, and the organisation that was active when the app registered it.
--
--   push_device   a token is unique across the database: when another person signs in on the same
--                 phone, registering moves the token to them, so the earlier person's
--                 notifications stop arriving on a phone they no longer use.
--
-- Members register only through app.push_device_register (SECURITY DEFINER, crm_definer): the
-- token may belong to a row of another member or organisation that crm_app cannot see. Members see
-- and delete only their own rows (sign-out). The worker (system actor, no app.user_id) reads the
-- recipients' tokens to send and deletes tokens FCM reports as dead. A token is not contact data
-- and is never shown on a page.

CREATE TABLE "push_device" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'ANDROID',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_device_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_device_token_key" ON "push_device"("token");
CREATE UNIQUE INDEX "push_device_org_id_id_key" ON "push_device"("org_id", "id");
CREATE INDEX "push_device_org_id_user_id_idx" ON "push_device"("org_id", "user_id");

-- A device row is only a delivery address: it goes with the membership.
ALTER TABLE "push_device" ADD CONSTRAINT "push_device_org_id_user_id_fkey" FOREIGN KEY ("org_id", "user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE push_device
  ADD CONSTRAINT push_device_platform CHECK (platform IN ('ANDROID')),
  ADD CONSTRAINT push_device_token_shape CHECK (length(token) BETWEEN 20 AND 4096
    AND token ~ '^[A-Za-z0-9_:.-]+$');

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
ALTER TABLE push_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_device FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON push_device FOR ALL TO crm_migrator
  USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON push_device FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
-- A member: their own rows. The worker (no app.user_id): every row of the organisation.
CREATE POLICY own_device_read ON push_device AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_user_id()) IS NULL OR user_id = (SELECT app.current_user_id()));
CREATE POLICY own_device_delete ON push_device AS RESTRICTIVE FOR DELETE TO crm_app
  USING ((SELECT app.current_user_id()) IS NULL OR user_id = (SELECT app.current_user_id()));
GRANT SELECT, DELETE ON push_device TO crm_app;

-- ---------------------------------------------------------------------------
-- Registration
-- ---------------------------------------------------------------------------
CREATE POLICY definer_register ON push_device FOR ALL TO crm_definer
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON push_device TO crm_definer;

-- Registers the calling member's phone in the active organisation. Refused without a session user
-- and organisation, or for a membership that is not ACTIVE. Returns the row id.
CREATE FUNCTION app.push_device_register(p_token text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_org uuid := app.current_org_id();
  v_user uuid := app.current_user_id();
  v_id uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'push_device_register needs a session member' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_membership m
     WHERE m.org_id = v_org AND m.user_id = v_user AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'push_device_register needs an active membership' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.push_device (org_id, user_id, token)
  VALUES (v_org, v_user, p_token)
  ON CONFLICT (token) DO UPDATE
    SET org_id = EXCLUDED.org_id, user_id = EXCLUDED.user_id, updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
ALTER FUNCTION app.push_device_register(text) OWNER TO crm_definer;
REVOKE ALL ON FUNCTION app.push_device_register(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.push_device_register(text) TO crm_app;
