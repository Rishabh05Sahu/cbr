-- Phase 3 slice 7: phone masking and reveal auditing (FR-060; FR-025 org setting; role matrix
-- §4.1 lead.reveal_phone and §4.6 org.security_policy.manage; workflow B audit
-- lead.phone_revealed; threat model: reveal is a server-checked permission with a daily cap;
-- ADR-0013). Calling, dialling and call intents are not part of this change.
--
--   organization.phone_masking            org setting, off by default (FR-060 "org setting";
--                                         nothing changes until an Owner enables it)
--   organization.phone_reveal_daily_cap   reveals per person per org-local day (FR-060
--                                         "daily reveal cap configurable")
--   lead_phone_reveal                     append-only record of each reveal. Inserting one is
--                                         the reveal: the guard refuses it unless masking is
--                                         on, the session member has a lead role and is under
--                                         today's cap; its trigger writes the lead.phone_revealed
--                                         audit row. The number itself is never stored here or
--                                         in the audit row.
--
-- Same conventions as 0015: org-scoped composite foreign keys, RLS enabled and forced, migrator
-- maintenance, crm_app tenant isolation, RESTRICTIVE insert policy stamping the session user and
-- the transaction time, no UPDATE or DELETE grants.

ALTER TABLE organization
  ADD COLUMN phone_masking BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN phone_reveal_daily_cap INTEGER NOT NULL DEFAULT 50;
ALTER TABLE organization
  ADD CONSTRAINT organization_phone_reveal_daily_cap CHECK (phone_reveal_daily_cap BETWEEN 1 AND 1000);

CREATE TABLE "lead_phone_reveal" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "revealed_by" UUID NOT NULL,
    "revealed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_phone_reveal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lead_phone_reveal_org_id_id_key" ON "lead_phone_reveal"("org_id", "id");
CREATE INDEX "lead_phone_reveal_org_id_revealed_by_revealed_at_idx" ON "lead_phone_reveal"("org_id", "revealed_by", "revealed_at");
CREATE INDEX "lead_phone_reveal_org_id_lead_id_revealed_at_idx" ON "lead_phone_reveal"("org_id", "lead_id", "revealed_at" DESC);

ALTER TABLE "lead_phone_reveal" ADD CONSTRAINT "lead_phone_reveal_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lead_phone_reveal" ADD CONSTRAINT "lead_phone_reveal_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lead_phone_reveal" ADD CONSTRAINT "lead_phone_reveal_org_id_revealed_by_fkey" FOREIGN KEY ("org_id", "revealed_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- The masking settings belong to the Owner (org.security_policy.manage, roles §4.6). Only the
-- app role is checked (other roles, such as the platform console, have no grant on these
-- columns), and the role function is called only for it (others cannot execute it).
CREATE FUNCTION app.organization_security_policy_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF current_user = 'crm_app' THEN
    IF (NEW.phone_masking IS DISTINCT FROM OLD.phone_masking
        OR NEW.phone_reveal_daily_cap IS DISTINCT FROM OLD.phone_reveal_daily_cap)
       AND app.current_member_role() IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'only the Owner changes phone masking' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.organization_security_policy_guard() FROM PUBLIC;
CREATE TRIGGER organization_security_policy_guard
  BEFORE UPDATE OF phone_masking, phone_reveal_daily_cap ON organization
  FOR EACH ROW EXECUTE FUNCTION app.organization_security_policy_guard();

-- A reveal: masking is on, the lead is a live row of the org, and the person is under today's
-- cap (counted in the org's time zone, serialised per person so parallel reveals cannot pass it).
CREATE FUNCTION app.lead_phone_reveal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  o record;
  used int;
BEGIN
  SELECT x.phone_masking, x.phone_reveal_daily_cap, x.time_zone INTO o
    FROM public.organization x WHERE x.id = NEW.org_id;
  IF NOT FOUND OR NOT o.phone_masking THEN
    RAISE EXCEPTION 'phone masking is off: there is nothing to reveal' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM public.lead l WHERE l.id = NEW.lead_id AND l.org_id = NEW.org_id
    AND l.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead % not found', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('phone_reveal:' || NEW.org_id || ':' || NEW.revealed_by, 0));
  SELECT count(*) INTO used FROM public.lead_phone_reveal r
    WHERE r.org_id = NEW.org_id AND r.revealed_by = NEW.revealed_by
      AND r.revealed_at >= (date_trunc('day', now() AT TIME ZONE o.time_zone) AT TIME ZONE o.time_zone);
  IF used >= o.phone_reveal_daily_cap THEN
    RAISE EXCEPTION 'daily phone reveal limit (%) reached', o.phone_reveal_daily_cap
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_phone_reveal_guard() FROM PUBLIC;
CREATE TRIGGER lead_phone_reveal_guard BEFORE INSERT ON lead_phone_reveal
  FOR EACH ROW EXECUTE FUNCTION app.lead_phone_reveal_guard();

-- Every reveal is audited (FR-060 "reveal creates audit row"; workflow B lead.phone_revealed),
-- in the same transaction, without the number (lead-lifecycle §6).
CREATE FUNCTION app.lead_phone_reveal_audit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO public.audit_log (org_id, actor_user_id, actor_kind, action, entity_type, entity_id,
                                metadata, occurred_at)
  VALUES (NEW.org_id, NEW.revealed_by, 'USER', 'lead.phone_revealed', 'lead', NEW.lead_id,
          jsonb_build_object('revealId', NEW.id), now());
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lead_phone_reveal_audit() FROM PUBLIC;
CREATE TRIGGER lead_phone_reveal_audit AFTER INSERT ON lead_phone_reveal
  FOR EACH ROW EXECUTE FUNCTION app.lead_phone_reveal_audit();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

ALTER TABLE lead_phone_reveal ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_phone_reveal FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON lead_phone_reveal FOR ALL TO crm_migrator
  USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON lead_phone_reveal FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
-- Owner/Admin read every reveal (audit.read); everyone else only their own (today's count).
CREATE POLICY reveal_read ON lead_phone_reveal AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin')
    OR revealed_by = (SELECT app.current_user_id()));
-- Lead roles only (lead.reveal_phone, roles §4.1), as the session user, now.
CREATE POLICY reveal_insert ON lead_phone_reveal AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive')
    AND revealed_by = (SELECT app.current_user_id()) AND revealed_at = now());

-- Append-only: no UPDATE or DELETE.
GRANT SELECT, INSERT ON lead_phone_reveal TO crm_app;
-- The Owner sets masking through the app (guarded above).
GRANT UPDATE (phone_masking, phone_reveal_daily_cap) ON organization TO crm_app;
