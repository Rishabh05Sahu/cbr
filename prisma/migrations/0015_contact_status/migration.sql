-- Phase 3 slice 6: contact status / Do-Not-Contact (FR-065; lead-lifecycle §1 and §4; threat
-- model T16 and §8; legal checklist C3/C4; ADR-0012). Calling and messaging launchers, outcome
-- logging and the per-channel ConsentRecord (opt-ins, A2) are not part of this change.
--
--   lead_contact_status_event  append-only history of lead.contact_status (OK | DO_NOT_CONTACT |
--                              INVALID). A change to DO_NOT_CONTACT is the lead's consent-
--                              withdrawal record ("stop contacting me"), with how it was asked
--                              for, a reason and an optional evidence reference. Lifting it is
--                              a recorded grant (basis + evidence), by Owner/Admin only.
--
-- The event is the only way to change lead.contact_status: inserting one checks the transition
-- (below), then its trigger updates the lead (version + 1) and writes the timeline entry and the
-- audit row in the same transaction. A direct UPDATE of lead.contact_status is refused.
--
-- Transitions (owner decisions 2026-10-28, ADR-0012):
--   OK -> DO_NOT_CONTACT, INVALID -> DO_NOT_CONTACT   anyone allowed to edit the lead; method
--                                                     (VERBAL | WRITTEN | OTHER) and reason
--   OK -> INVALID, INVALID -> OK                       anyone allowed to edit the lead; reason
--   DO_NOT_CONTACT -> OK                               Owner/Admin only; basis (VERBAL | WRITTEN |
--                                                     FORM_OPT_IN | INBOUND_ENQUIRY), evidence
--                                                     reference and reason
--   DO_NOT_CONTACT -> INVALID                          refused (it would weaken the restriction)
-- An archived lead only accepts -> DO_NOT_CONTACT; a merged or deleted lead accepts nothing.
-- Automatic: a new lead linked to a closed DO_NOT_CONTACT lead (previous_lead_id, same phone)
-- starts DO_NOT_CONTACT (CARRY_OVER); merging a DO_NOT_CONTACT lead requires the survivor to be
-- DO_NOT_CONTACT first (the app records a MERGE event on the survivor before the merge).
--
-- Same conventions as 0003/0012/0014: org-scoped composite foreign keys, RLS enabled and
-- forced, migrator maintenance, crm_app tenant isolation, RESTRICTIVE insert policy stamping
-- the session user and the transaction time, no UPDATE or DELETE grants.

CREATE TABLE "lead_contact_status_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "method" TEXT,
    "reason" TEXT,
    "evidence_ref" TEXT,
    "related_lead_id" UUID,
    "changed_by" UUID,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_contact_status_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lead_contact_status_event_org_id_id_key" ON "lead_contact_status_event"("org_id", "id");
CREATE INDEX "lead_contact_status_event_org_id_lead_id_changed_at_idx" ON "lead_contact_status_event"("org_id", "lead_id", "changed_at" DESC);

ALTER TABLE "lead_contact_status_event" ADD CONSTRAINT "lead_contact_status_event_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lead_contact_status_event" ADD CONSTRAINT "lead_contact_status_event_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lead_contact_status_event" ADD CONSTRAINT "lead_contact_status_event_org_id_related_lead_id_fkey" FOREIGN KEY ("org_id", "related_lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lead_contact_status_event" ADD CONSTRAINT "lead_contact_status_event_org_id_changed_by_fkey" FOREIGN KEY ("org_id", "changed_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE lead_contact_status_event
  ADD CONSTRAINT lead_contact_status_event_statuses CHECK (
    from_status IN ('OK', 'DO_NOT_CONTACT', 'INVALID')
    AND to_status IN ('OK', 'DO_NOT_CONTACT', 'INVALID') AND from_status <> to_status),
  ADD CONSTRAINT lead_contact_status_event_origin CHECK (origin IN ('MANUAL', 'CARRY_OVER', 'MERGE')),
  ADD CONSTRAINT lead_contact_status_event_method CHECK (method IS NULL OR method IN
    ('VERBAL', 'WRITTEN', 'OTHER', 'FORM_OPT_IN', 'INBOUND_ENQUIRY')),
  ADD CONSTRAINT lead_contact_status_event_reason CHECK (reason IS NULL
    OR (length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason))),
  ADD CONSTRAINT lead_contact_status_event_evidence CHECK (evidence_ref IS NULL
    OR (length(evidence_ref) BETWEEN 1 AND 300 AND evidence_ref = btrim(evidence_ref))),
  -- Manual changes always say why; automatic ones name the lead they come from.
  ADD CONSTRAINT lead_contact_status_event_shape CHECK (
    (origin = 'MANUAL' AND reason IS NOT NULL AND related_lead_id IS NULL)
    OR (origin IN ('CARRY_OVER', 'MERGE') AND to_status = 'DO_NOT_CONTACT'
        AND related_lead_id IS NOT NULL AND related_lead_id <> lead_id
        AND method IS NULL AND reason IS NULL AND evidence_ref IS NULL));

-- The timeline gains a CONTACT_STATUS entry type (widened as in 0004/0006/0012).
ALTER TABLE lead_activity DROP CONSTRAINT lead_activity_type;
ALTER TABLE lead_activity
  ADD CONSTRAINT lead_activity_type CHECK (type IN ('CREATED', 'ENQUIRY', 'ASSIGNED', 'STAGE',
    'NOTE', 'FIELD_CHANGED', 'ARCHIVED', 'RESTORED', 'MERGED', 'TASK', 'CONTACT_STATUS'));

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- An event must describe a permitted change of the lead's current status.
CREATE FUNCTION app.lead_contact_status_event_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  l record;
  rel record;
BEGIN
  SELECT x.contact_status, x.archived_at, x.merged_into_lead_id, x.deleted_at,
         x.previous_lead_id
    INTO l FROM public.lead x WHERE x.id = NEW.lead_id AND x.org_id = NEW.org_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead % not found', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF l.merged_into_lead_id IS NOT NULL OR l.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'lead % was merged or deleted and cannot change', NEW.lead_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.origin = 'CARRY_OVER' THEN
    -- Recorded once (the lead's first event), for a lead that follows a closed DO_NOT_CONTACT
    -- lead and starts DO_NOT_CONTACT (lead_contact_status_insert).
    SELECT r.contact_status INTO rel FROM public.lead r
      WHERE r.id = NEW.related_lead_id AND r.org_id = NEW.org_id;
    IF EXISTS (SELECT 1 FROM public.lead_contact_status_event e WHERE e.lead_id = NEW.lead_id)
       OR l.previous_lead_id IS DISTINCT FROM NEW.related_lead_id
       OR rel.contact_status IS DISTINCT FROM 'DO_NOT_CONTACT' OR NEW.from_status <> 'OK'
       OR l.contact_status <> 'DO_NOT_CONTACT' THEN
      RAISE EXCEPTION 'lead % carry-over does not match its previous lead', NEW.lead_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.from_status <> l.contact_status THEN
    RAISE EXCEPTION 'lead % contact status is %, not %', NEW.lead_id, l.contact_status,
      NEW.from_status USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.origin = 'MERGE' THEN
    -- The duplicate being merged into this lead asked not to be contacted.
    SELECT r.contact_status, r.merged_into_lead_id INTO rel FROM public.lead r
      WHERE r.id = NEW.related_lead_id AND r.org_id = NEW.org_id;
    IF rel.contact_status IS DISTINCT FROM 'DO_NOT_CONTACT' OR rel.merged_into_lead_id IS NOT NULL THEN
      RAISE EXCEPTION 'lead % merge carry-over needs a live DO_NOT_CONTACT duplicate', NEW.lead_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- MANUAL
  IF l.archived_at IS NOT NULL AND NEW.to_status <> 'DO_NOT_CONTACT' THEN
    RAISE EXCEPTION 'lead % is archived: only DO_NOT_CONTACT can be recorded', NEW.lead_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.from_status = 'DO_NOT_CONTACT' THEN
    IF NEW.to_status <> 'OK' THEN
      RAISE EXCEPTION 'lead % DO_NOT_CONTACT can only be lifted to OK', NEW.lead_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF app.current_member_role() IS NULL OR app.current_member_role() NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'only Owner or Admin can lift DO_NOT_CONTACT' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.method IS NULL OR NEW.method NOT IN ('VERBAL', 'WRITTEN', 'FORM_OPT_IN', 'INBOUND_ENQUIRY')
       OR NEW.evidence_ref IS NULL THEN
      RAISE EXCEPTION 'lifting DO_NOT_CONTACT needs a consent basis and evidence'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.to_status = 'DO_NOT_CONTACT' THEN
    IF NEW.method IS NULL OR NEW.method NOT IN ('VERBAL', 'WRITTEN', 'OTHER') THEN
      RAISE EXCEPTION 'DO_NOT_CONTACT needs how it was requested' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.method IS NOT NULL THEN
    RAISE EXCEPTION 'OK/INVALID changes take no method' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_contact_status_event_guard() FROM PUBLIC;
CREATE TRIGGER lead_contact_status_event_guard BEFORE INSERT ON lead_contact_status_event
  FOR EACH ROW EXECUTE FUNCTION app.lead_contact_status_event_guard();

-- Applies the event: the lead's status (version + 1), a timeline entry and an audit row. The
-- audit row and timeline name the statuses and how the change came about, never the reason or
-- evidence text (they may hold personal data; they stay on the event).
CREATE FUNCTION app.lead_contact_status_event_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  UPDATE public.lead SET contact_status = NEW.to_status, version = version + 1, updated_at = now()
    WHERE id = NEW.lead_id AND contact_status <> NEW.to_status;
  INSERT INTO public.lead_activity (org_id, lead_id, type, actor_id, summary, ref_type, ref_id,
                                    occurred_at)
  VALUES (NEW.org_id, NEW.lead_id, 'CONTACT_STATUS', NEW.changed_by,
          jsonb_build_object('from', NEW.from_status, 'to', NEW.to_status, 'origin', NEW.origin,
                             'method', NEW.method),
          'lead_contact_status_event', NEW.id, now());
  INSERT INTO public.audit_log (org_id, actor_user_id, actor_kind, action, entity_type, entity_id,
                                metadata, occurred_at)
  VALUES (NEW.org_id, NEW.changed_by, CASE WHEN NEW.changed_by IS NULL THEN 'SYSTEM' ELSE 'USER' END,
          'lead.contact_status_changed', 'lead', NEW.lead_id,
          jsonb_build_object('from', NEW.from_status, 'to', NEW.to_status, 'origin', NEW.origin,
                             'method', NEW.method, 'eventId', NEW.id,
                             'relatedLeadId', NEW.related_lead_id),
          now());
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lead_contact_status_event_apply() FROM PUBLIC;
CREATE TRIGGER lead_contact_status_event_apply AFTER INSERT ON lead_contact_status_event
  FOR EACH ROW EXECUTE FUNCTION app.lead_contact_status_event_apply();

-- lead.contact_status changes only through an event of this transaction; a DO_NOT_CONTACT lead
-- is merged only into a DO_NOT_CONTACT survivor.
CREATE FUNCTION app.lead_contact_status_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.contact_status IS DISTINCT FROM OLD.contact_status THEN
    PERFORM 1 FROM public.lead_contact_status_event e
      WHERE e.lead_id = OLD.id AND e.org_id = OLD.org_id AND e.from_status = OLD.contact_status
        AND e.to_status = NEW.contact_status AND e.changed_at = now();
    IF pg_trigger_depth() < 2 OR NOT FOUND THEN
      RAISE EXCEPTION 'lead % contact status changes only through a contact status event', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.contact_status = 'DO_NOT_CONTACT' AND NEW.merged_into_lead_id IS NOT NULL
     AND OLD.merged_into_lead_id IS NULL THEN
    PERFORM 1 FROM public.lead t
      WHERE t.id = NEW.merged_into_lead_id AND t.org_id = NEW.org_id
        AND t.contact_status = 'DO_NOT_CONTACT';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'lead % is DO_NOT_CONTACT: its survivor must be DO_NOT_CONTACT first', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_contact_status_guard() FROM PUBLIC;
CREATE TRIGGER lead_contact_status_guard BEFORE UPDATE ON lead
  FOR EACH ROW EXECUTE FUNCTION app.lead_contact_status_guard();

-- A new lead starts OK, unless it follows a closed DO_NOT_CONTACT lead for the same phone.
CREATE FUNCTION app.lead_contact_status_insert() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.previous_lead_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.lead p
        WHERE p.id = NEW.previous_lead_id AND p.org_id = NEW.org_id
          AND p.contact_status = 'DO_NOT_CONTACT') THEN
    NEW.contact_status := 'DO_NOT_CONTACT';
  ELSIF NEW.contact_status <> 'OK' THEN
    RAISE EXCEPTION 'a new lead starts with contact status OK' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_contact_status_insert() FROM PUBLIC;
CREATE TRIGGER lead_contact_status_insert BEFORE INSERT ON lead
  FOR EACH ROW EXECUTE FUNCTION app.lead_contact_status_insert();

CREATE FUNCTION app.lead_contact_status_carry_over() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.contact_status = 'DO_NOT_CONTACT' THEN
    INSERT INTO public.lead_contact_status_event (org_id, lead_id, from_status, to_status, origin,
                                                  related_lead_id, changed_by, changed_at)
    VALUES (NEW.org_id, NEW.id, 'OK', 'DO_NOT_CONTACT', 'CARRY_OVER', NEW.previous_lead_id,
            NEW.created_by, now());
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lead_contact_status_carry_over() FROM PUBLIC;
CREATE TRIGGER lead_contact_status_carry_over AFTER INSERT ON lead
  FOR EACH ROW EXECUTE FUNCTION app.lead_contact_status_carry_over();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

ALTER TABLE lead_contact_status_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_contact_status_event FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON lead_contact_status_event FOR ALL TO crm_migrator
  USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON lead_contact_status_event FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
-- Lead roles only (lead.read / lead.update in the role matrix): not HR, not support sessions.
CREATE POLICY lead_roles_read ON lead_contact_status_event AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive'));
-- Written as the session user, now; manual changes only by lead roles (carry-over rows follow
-- the lead's creator, which the lead insert policy already ties to the session user).
CREATE POLICY actor_is_session_user ON lead_contact_status_event AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (changed_by IS NOT DISTINCT FROM (SELECT app.current_user_id())
    AND changed_at = now()
    AND (origin = 'CARRY_OVER'
      OR (SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive')));

-- Append-only: no UPDATE or DELETE.
GRANT SELECT, INSERT ON lead_contact_status_event TO crm_app;
