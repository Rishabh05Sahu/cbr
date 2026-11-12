-- FR-080/081 (Call and WhatsApp launchers) and the record FR-082 prompts from. Owner approval
-- 2026-11-12 "for test data"; ADR-0025. Legal gate G5 stays open: this does not clear the product
-- for real customer data or outbound contact.
--
--   call_intent   append-only record of one tap on the lead page's Call (tel:) or WhatsApp (wa.me)
--                 button (metrics L0). Never a call: a web page cannot observe the call. Whether a
--                 tap was followed by a logged outcome is derived (an interaction by the same person
--                 on the same lead within two hours, metrics K08b), so nothing here is updated.
--
-- Contact status (FR-065, ADR-0012): a tap on a DO_NOT_CONTACT lead is refused (no override); a
-- tap on an INVALID number needs invalid_number_confirmed. The lead's status at the tap is stored
-- and must match the lead (the row is share-locked).
-- Phone masking (FR-060, ADR-0013 known limitation "dialling a masked number counts as a
-- reveal"): with masking on, the tap must carry the reveal this person made of this lead in the
-- same transaction, so the daily cap and the lead.phone_revealed audit row apply to every dial.
--
-- Same conventions as 0016/0017: org-scoped composite foreign keys, RLS enabled and forced,
-- migrator maintenance, crm_app tenant isolation, RESTRICTIVE insert policy stamping the session
-- user and the transaction time, no UPDATE or DELETE grants. No retention purge is defined here
-- (domain model: one year; G5 retention awaits counsel, as for interactions).

CREATE TABLE "call_intent" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "number_kind" TEXT NOT NULL,
    "contact_status_at_tap" TEXT NOT NULL,
    "invalid_number_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "phone_reveal_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_intent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "call_intent_org_id_id_key" ON "call_intent"("org_id", "id");
CREATE INDEX "call_intent_org_id_user_id_lead_id_created_at_idx" ON "call_intent"("org_id", "user_id", "lead_id", "created_at" DESC);
CREATE INDEX "call_intent_org_id_created_at_idx" ON "call_intent"("org_id", "created_at");

ALTER TABLE "call_intent" ADD CONSTRAINT "call_intent_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "call_intent" ADD CONSTRAINT "call_intent_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "call_intent" ADD CONSTRAINT "call_intent_org_id_user_id_fkey" FOREIGN KEY ("org_id", "user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "call_intent" ADD CONSTRAINT "call_intent_org_id_phone_reveal_id_fkey" FOREIGN KEY ("org_id", "phone_reveal_id") REFERENCES "lead_phone_reveal"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Vocabularies (mirrored in src/modules/interactions/call-intents.ts).
ALTER TABLE call_intent
  ADD CONSTRAINT call_intent_channel CHECK (channel IN ('PHONE_NATIVE', 'WHATSAPP_APP')),
  ADD CONSTRAINT call_intent_number_kind CHECK (number_kind IN ('PRIMARY', 'ALTERNATE')),
  ADD CONSTRAINT call_intent_contact_status CHECK (contact_status_at_tap IN
    ('OK', 'DO_NOT_CONTACT', 'INVALID'));

-- ---------------------------------------------------------------------------
-- Integrity trigger
-- ---------------------------------------------------------------------------

-- A live, writable lead of the org that has the number opened; the status the person saw is the
-- lead's status now; outbound contact follows the FR-065 rule; with masking on, the tap carries
-- this person's reveal of this lead from this transaction.
CREATE FUNCTION app.call_intent_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  l record;
  masking boolean;
BEGIN
  SELECT x.contact_status, x.archived_at, x.merged_into_lead_id, x.deleted_at,
         x.alternate_phone_e164 INTO l
    FROM public.lead x WHERE x.id = NEW.lead_id AND x.org_id = NEW.org_id FOR SHARE;
  IF NOT FOUND OR l.deleted_at IS NOT NULL OR l.merged_into_lead_id IS NOT NULL THEN
    RAISE EXCEPTION 'lead % not found', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF l.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'lead % is archived', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.number_kind = 'ALTERNATE' AND l.alternate_phone_e164 IS NULL THEN
    RAISE EXCEPTION 'lead % has no alternate number', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.contact_status_at_tap <> l.contact_status THEN
    RAISE EXCEPTION 'lead % contact status is %, not %', NEW.lead_id, l.contact_status,
      NEW.contact_status_at_tap USING ERRCODE = 'check_violation';
  END IF;
  IF l.contact_status = 'DO_NOT_CONTACT' THEN
    RAISE EXCEPTION 'lead % is DO_NOT_CONTACT: it cannot be called or messaged', NEW.lead_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF l.contact_status = 'INVALID' AND NOT NEW.invalid_number_confirmed THEN
    RAISE EXCEPTION 'lead % number is INVALID: a call or message needs a confirmation', NEW.lead_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT o.phone_masking INTO masking FROM public.organization o WHERE o.id = NEW.org_id;
  IF masking THEN
    PERFORM 1 FROM public.lead_phone_reveal r
      WHERE r.id = NEW.phone_reveal_id AND r.org_id = NEW.org_id AND r.lead_id = NEW.lead_id
        AND r.revealed_by = NEW.user_id AND r.revealed_at = now();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'phone masking is on: a call or message on lead % needs a reveal', NEW.lead_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.call_intent_guard() FROM PUBLIC;
CREATE TRIGGER call_intent_guard BEFORE INSERT ON call_intent
  FOR EACH ROW EXECUTE FUNCTION app.call_intent_guard();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

ALTER TABLE call_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON call_intent FOR ALL TO crm_migrator
  USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON call_intent FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
-- Read: the lead roles (the prompt reads one's own; reports read in scope). Not HR, not support.
CREATE POLICY call_intent_read ON call_intent AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive'));
-- Insert: lead roles only (interaction.create, roles §4.2), as the session user, now.
CREATE POLICY actor_is_session_user ON call_intent AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (user_id = (SELECT app.current_user_id()) AND created_at = now()
    AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive'));

-- Append-only: no UPDATE or DELETE.
GRANT SELECT, INSERT ON call_intent TO crm_app;
