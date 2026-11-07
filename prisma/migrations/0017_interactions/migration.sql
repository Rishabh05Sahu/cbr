-- Phase 3 slice 8: manual interaction logging (FR-083), the one-submit outcome sheet (FR-084) and
-- interactions on the unified lead timeline (FR-085). Owner approval 2026-10-29 (Q1–Q5); ADR-0014.
-- Call and WhatsApp launchers, call intents, provider events, recordings and outbound sends are
-- not part of this change (FR-080–FR-082, Phase 6). Legal gate G5 stays open.
--
--   interaction   append-only record of one contact a person reports: channel, direction,
--                 outcome (lead-lifecycle §3), when it happened, optional approximate duration
--                 and notes. source = MANUAL and status = LOGGED only (provider rows arrive with
--                 Phase 6 and widen these CHECKs). Its trigger writes the INTERACTION timeline
--                 entry in the same transaction; notes never go into the timeline summary.
--
-- Contact status (FR-065, ADR-0012; owner decisions 2026-10-29):
--   OUTBOUND on a DO_NOT_CONTACT lead          refused (no override, no breach record: Q2)
--   OUTBOUND on an INVALID lead                 only with invalid_number_confirmed
--   INBOUND on a DO_NOT_CONTACT lead            allowed (Q1); the status does not change
-- The lead's status at logging time is stored (contact_status_at_log) and must match the lead.
-- An interaction never changes contact status itself: outcome-driven changes (Q3) go through a
-- lead_contact_status_event in the same transaction, written by the application.
--
-- Same conventions as 0015/0016: org-scoped composite foreign keys, RLS enabled and forced,
-- migrator maintenance, crm_app tenant isolation, RESTRICTIVE insert policy stamping the session
-- user and the transaction time, no UPDATE or DELETE grants. No retention period or purge is
-- defined here (G5: interaction and notes retention await counsel, ADR-0014).

CREATE TABLE "interaction" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'LOGGED',
    "outcome" TEXT NOT NULL,
    "outcome_group" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "logged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "manual_duration_minutes" INTEGER,
    "notes" TEXT,
    "contact_status_at_log" TEXT NOT NULL,
    "invalid_number_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "client_idempotency_key" UUID NOT NULL,

    CONSTRAINT "interaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interaction_org_id_id_key" ON "interaction"("org_id", "id");
CREATE UNIQUE INDEX "interaction_org_id_user_id_client_idempotency_key_key" ON "interaction"("org_id", "user_id", "client_idempotency_key");
CREATE INDEX "interaction_org_id_lead_id_occurred_at_idx" ON "interaction"("org_id", "lead_id", "occurred_at" DESC);
CREATE INDEX "interaction_org_id_user_id_occurred_at_idx" ON "interaction"("org_id", "user_id", "occurred_at");

ALTER TABLE "interaction" ADD CONSTRAINT "interaction_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "interaction" ADD CONSTRAINT "interaction_org_id_user_id_fkey" FOREIGN KEY ("org_id", "user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Vocabularies and shapes (mirrored in src/modules/interactions/rules.ts).
ALTER TABLE interaction
  ADD CONSTRAINT interaction_channel CHECK (channel IN
    ('PHONE_NATIVE', 'WHATSAPP_APP_CALL', 'WHATSAPP_APP_MESSAGE', 'SMS', 'EMAIL', 'IN_PERSON')),
  ADD CONSTRAINT interaction_direction CHECK (direction IN ('OUTBOUND', 'INBOUND')),
  ADD CONSTRAINT interaction_source CHECK (source = 'MANUAL'),
  ADD CONSTRAINT interaction_status CHECK (status = 'LOGGED'),
  ADD CONSTRAINT interaction_contact_status CHECK (contact_status_at_log IN
    ('OK', 'DO_NOT_CONTACT', 'INVALID')),
  -- lead-lifecycle §3 groups. UNKNOWN_NOT_CONNECTED is provider-reported only.
  ADD CONSTRAINT interaction_outcome_group CHECK (
    (outcome_group = 'NOT_CONNECTED' AND outcome IN ('NO_ANSWER', 'BUSY', 'SWITCHED_OFF',
       'NOT_REACHABLE', 'CALL_REJECTED', 'WHATSAPP_NOT_AVAILABLE'))
    OR (outcome_group = 'INVALID' AND outcome IN ('WRONG_NUMBER', 'INVALID_NUMBER'))
    OR (outcome_group = 'CONNECTED' AND outcome IN ('CONNECTED_INTERESTED', 'CONNECTED_CALL_BACK',
       'CONNECTED_NOT_INTERESTED', 'CONNECTED_ALREADY_BOUGHT', 'CONNECTED_BROKER',
       'CONNECTED_DO_NOT_CALL'))
    OR (outcome_group = 'OTHER' AND outcome IN ('MESSAGE_SENT', 'VOICEMAIL', 'MEETING_HELD'))),
  -- Which outcomes fit which channel and direction.
  ADD CONSTRAINT interaction_outcome_fits CHECK (
    outcome_group = 'CONNECTED'
    OR (outcome IN ('NO_ANSWER', 'BUSY', 'SWITCHED_OFF', 'NOT_REACHABLE', 'CALL_REJECTED')
        AND channel IN ('PHONE_NATIVE', 'WHATSAPP_APP_CALL') AND direction = 'OUTBOUND')
    OR (outcome = 'VOICEMAIL' AND channel = 'PHONE_NATIVE' AND direction = 'OUTBOUND')
    OR (outcome = 'WHATSAPP_NOT_AVAILABLE'
        AND channel IN ('WHATSAPP_APP_CALL', 'WHATSAPP_APP_MESSAGE') AND direction = 'OUTBOUND')
    OR (outcome = 'MESSAGE_SENT'
        AND channel IN ('WHATSAPP_APP_MESSAGE', 'SMS', 'EMAIL') AND direction = 'OUTBOUND')
    OR (outcome = 'MEETING_HELD' AND channel = 'IN_PERSON')
    OR (outcome = 'WRONG_NUMBER' AND channel IN ('PHONE_NATIVE', 'WHATSAPP_APP_CALL',
        'WHATSAPP_APP_MESSAGE', 'SMS'))
    OR (outcome = 'INVALID_NUMBER' AND direction = 'OUTBOUND' AND channel IN ('PHONE_NATIVE',
        'WHATSAPP_APP_CALL', 'WHATSAPP_APP_MESSAGE', 'SMS'))),
  -- Reported time: not after logging, at most seven days before it (owner default 2026-10-29).
  ADD CONSTRAINT interaction_occurred_at CHECK (occurred_at <= logged_at
    AND occurred_at >= logged_at - interval '7 days'),
  -- A person's estimate, for calls and meetings only (provider-reported duration is separate).
  ADD CONSTRAINT interaction_duration CHECK (manual_duration_minutes IS NULL
    OR (manual_duration_minutes BETWEEN 1 AND 600
        AND channel IN ('PHONE_NATIVE', 'WHATSAPP_APP_CALL', 'IN_PERSON'))),
  ADD CONSTRAINT interaction_notes CHECK (notes IS NULL
    OR (length(notes) BETWEEN 1 AND 2000 AND notes = btrim(notes)));

-- The timeline gains an INTERACTION entry type (widened as in 0004/0006/0012/0015).
ALTER TABLE lead_activity DROP CONSTRAINT lead_activity_type;
ALTER TABLE lead_activity
  ADD CONSTRAINT lead_activity_type CHECK (type IN ('CREATED', 'ENQUIRY', 'ASSIGNED', 'STAGE',
    'NOTE', 'FIELD_CHANGED', 'ARCHIVED', 'RESTORED', 'MERGED', 'TASK', 'CONTACT_STATUS',
    'INTERACTION'));

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- A live, writable lead of the org; the status the person saw is the lead's status now (the row
-- is share-locked, so a concurrent contact status change commits first or waits); outbound
-- contact follows the FR-065 rule.
CREATE FUNCTION app.interaction_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  l record;
BEGIN
  SELECT x.contact_status, x.archived_at, x.merged_into_lead_id, x.deleted_at INTO l
    FROM public.lead x WHERE x.id = NEW.lead_id AND x.org_id = NEW.org_id FOR SHARE;
  IF NOT FOUND OR l.deleted_at IS NOT NULL OR l.merged_into_lead_id IS NOT NULL THEN
    RAISE EXCEPTION 'lead % not found', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF l.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'lead % is archived', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.contact_status_at_log <> l.contact_status THEN
    RAISE EXCEPTION 'lead % contact status is %, not %', NEW.lead_id, l.contact_status,
      NEW.contact_status_at_log USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.direction = 'OUTBOUND' AND l.contact_status = 'DO_NOT_CONTACT' THEN
    RAISE EXCEPTION 'lead % is DO_NOT_CONTACT: outbound contact cannot be logged', NEW.lead_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.direction = 'OUTBOUND' AND l.contact_status = 'INVALID'
     AND NOT NEW.invalid_number_confirmed THEN
    RAISE EXCEPTION 'lead % number is INVALID: outbound contact needs a confirmation', NEW.lead_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.interaction_guard() FROM PUBLIC;
CREATE TRIGGER interaction_guard BEFORE INSERT ON interaction
  FOR EACH ROW EXECUTE FUNCTION app.interaction_guard();

-- The timeline entry, in the same transaction. Notes stay on the interaction (personal data).
CREATE FUNCTION app.interaction_timeline() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO public.lead_activity (org_id, lead_id, type, actor_id, summary, ref_type, ref_id,
                                    occurred_at)
  VALUES (NEW.org_id, NEW.lead_id, 'INTERACTION', NEW.user_id,
          jsonb_build_object('channel', NEW.channel, 'direction', NEW.direction,
                             'outcome', NEW.outcome, 'outcomeGroup', NEW.outcome_group,
                             'source', NEW.source, 'occurredAt', NEW.occurred_at,
                             'durationMinutes', NEW.manual_duration_minutes),
          'interaction', NEW.id, now());
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.interaction_timeline() FROM PUBLIC;
CREATE TRIGGER interaction_timeline AFTER INSERT ON interaction
  FOR EACH ROW EXECUTE FUNCTION app.interaction_timeline();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

ALTER TABLE interaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON interaction FOR ALL TO crm_migrator
  USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON interaction FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
-- interaction.read (role matrix §4.2): lead roles, and platform staff under an approved support
-- grant (no membership, read-only transaction). Not HR.
CREATE POLICY interaction_read ON interaction AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive')
    OR ((SELECT app.current_member_role()) IS NULL
        AND current_setting('transaction_read_only') = 'on'));
-- interaction.create: lead roles only, as the session user, now.
CREATE POLICY actor_is_session_user ON interaction AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (user_id = (SELECT app.current_user_id()) AND logged_at = now()
    AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive'));

-- Append-only: no UPDATE or DELETE (interaction.edit is deferred).
GRANT SELECT, INSERT ON interaction TO crm_app;
