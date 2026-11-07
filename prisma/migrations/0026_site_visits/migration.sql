-- Phase 4, FR-150–152: basic site visits (ADR-0022; OD-01 accepted: basic visits in Phase 4,
-- property links and per-property feedback in Phase 5 / FR-157). Domain model §2.7 SiteVisit.
--   FR-150: lead, date/time, free-text meeting point, assigned salesperson; the lead moves to Site
--           Visit Scheduled in the same transaction; reminders for the assignee (Workflow D: and the
--           person who scheduled it).
--   FR-151: Scheduled, Confirmed, Rescheduled (same record, reason + new time, count), Cancelled,
--           Attended, No-show; reasons for cancel and no-show; invalid transitions refused.
--   FR-152: visit-level outcome on Attended: interest, objections, notes, next action (required);
--           the lead moves to Site Visit Completed.
-- A site visit is its own entity (not a task or meeting). Property links (site_visit_property)
-- come with FR-157; a basic visit has none. Reminders reuse the FR-106 pattern (0023): a definer
-- claim records each reminder once and writes an outbox event. No existing migration is rewritten.

CREATE TABLE "site_visit" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "assigned_user_id" UUID NOT NULL,
    "scheduled_by" UUID NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "location_text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "reschedule_count" INTEGER NOT NULL DEFAULT 0,
    "cancel_reason" TEXT,
    "no_show_reason" TEXT,
    "attended_at" TIMESTAMPTZ(6),
    "interest_level" TEXT,
    "objections" TEXT[] NOT NULL DEFAULT '{}',
    "outcome_notes" TEXT,
    "next_action" TEXT,
    "closed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_visit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_visit_org_id_id_key" ON "site_visit"("org_id", "id");
CREATE INDEX "site_visit_org_id_assigned_user_id_scheduled_for_idx" ON "site_visit"("org_id", "assigned_user_id", "scheduled_for");
CREATE INDEX "site_visit_org_id_lead_id_idx" ON "site_visit"("org_id", "lead_id");
CREATE INDEX site_visit_open_scheduled_for_idx ON site_visit (scheduled_for)
  WHERE status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED');
ALTER TABLE "site_visit" ADD CONSTRAINT "site_visit_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "site_visit" ADD CONSTRAINT "site_visit_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "site_visit" ADD CONSTRAINT "site_visit_org_id_assigned_user_id_fkey" FOREIGN KEY ("org_id", "assigned_user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "site_visit" ADD CONSTRAINT "site_visit_org_id_scheduled_by_fkey" FOREIGN KEY ("org_id", "scheduled_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE site_visit
  ADD CONSTRAINT site_visit_status CHECK (status IN
    ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'ATTENDED', 'NO_SHOW')),
  ADD CONSTRAINT site_visit_location CHECK (length(location_text) BETWEEN 1 AND 300 AND location_text = btrim(location_text)),
  ADD CONSTRAINT site_visit_reschedule_count CHECK (reschedule_count >= 0),
  ADD CONSTRAINT site_visit_interest CHECK (interest_level IS NULL OR interest_level IN ('HIGH', 'MEDIUM', 'LOW', 'NONE')),
  ADD CONSTRAINT site_visit_objections CHECK (cardinality(objections) <= 20),
  ADD CONSTRAINT site_visit_texts CHECK (
    (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500)
    AND (no_show_reason IS NULL OR length(btrim(no_show_reason)) BETWEEN 1 AND 500)
    AND (outcome_notes IS NULL OR length(outcome_notes) BETWEEN 1 AND 5000)
    AND (next_action IS NULL OR length(btrim(next_action)) BETWEEN 1 AND 500)),
  -- One consistent state per status (FR-151/152).
  ADD CONSTRAINT site_visit_state CHECK (
    (status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED') AND closed_at IS NULL AND cancel_reason IS NULL
       AND no_show_reason IS NULL AND attended_at IS NULL AND interest_level IS NULL AND next_action IS NULL)
    OR (status = 'CANCELLED' AND closed_at IS NOT NULL AND cancel_reason IS NOT NULL AND attended_at IS NULL)
    OR (status = 'NO_SHOW' AND closed_at IS NOT NULL AND no_show_reason IS NOT NULL AND attended_at IS NULL)
    OR (status = 'ATTENDED' AND closed_at IS NOT NULL AND attended_at IS NOT NULL
       AND interest_level IS NOT NULL AND next_action IS NOT NULL)),
  ADD CONSTRAINT site_visit_version CHECK (version >= 1);

-- History of every status change and reschedule (append-only).
CREATE TABLE "site_visit_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "site_visit_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "previous_scheduled_for" TIMESTAMPTZ(6),
    "reason" TEXT,
    "actor_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_visit_event_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_visit_event_org_id_id_key" ON "site_visit_event"("org_id", "id");
CREATE INDEX "site_visit_event_org_id_site_visit_id_idx" ON "site_visit_event"("org_id", "site_visit_id");
ALTER TABLE "site_visit_event" ADD CONSTRAINT "site_visit_event_org_id_site_visit_id_fkey" FOREIGN KEY ("org_id", "site_visit_id") REFERENCES "site_visit"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "site_visit_event" ADD CONSTRAINT "site_visit_event_org_id_actor_id_fkey" FOREIGN KEY ("org_id", "actor_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE site_visit_event
  ADD CONSTRAINT site_visit_event_status CHECK (to_status IN
    ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'ATTENDED', 'NO_SHOW')),
  ADD CONSTRAINT site_visit_event_reason CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500);

-- FR-151 in the database: a closed visit never changes; transitions only along the allowed
-- paths; a reschedule changes the time and raises the count; the version always rises.
CREATE FUNCTION app.site_visit_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.status IN ('CANCELLED', 'ATTENDED', 'NO_SHOW') AND NEW.lead_id = OLD.lead_id THEN
    RAISE EXCEPTION 'site visit % is % and cannot change', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'site visit % version must increase', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.lead_id <> OLD.lead_id THEN
    RETURN NEW; -- a merge moves the visit to the surviving lead (nothing else changes)
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED')
        AND NEW.status IN ('CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'ATTENDED', 'NO_SHOW')
        AND NOT (OLD.status = 'CONFIRMED' AND NEW.status = 'CONFIRMED'))) THEN
    RAISE EXCEPTION 'site visit % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.scheduled_for IS DISTINCT FROM OLD.scheduled_for
     AND NOT (NEW.status = 'RESCHEDULED' AND NEW.reschedule_count = OLD.reschedule_count + 1) THEN
    RAISE EXCEPTION 'site visit % time changes only by a reschedule', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reschedule_count <> OLD.reschedule_count AND NEW.scheduled_for = OLD.scheduled_for THEN
    RAISE EXCEPTION 'site visit % reschedule needs a new time', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.closed_at IS NOT NULL AND OLD.closed_at IS NULL AND NEW.closed_at <> now() THEN
    RAISE EXCEPTION 'site visit % close time must be now', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.site_visit_guard() FROM PUBLIC;
CREATE TRIGGER site_visit_guard BEFORE UPDATE ON site_visit FOR EACH ROW EXECUTE FUNCTION app.site_visit_guard();

-- A visit is scheduled only on a live, open lead (not Won/Lost, merged or deleted), as tasks (0013).
CREATE FUNCTION app.site_visit_lead_open_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  PERFORM 1 FROM public.lead l
    WHERE l.id = NEW.lead_id AND l.stage NOT IN ('WON', 'LOST')
      AND l.merged_into_lead_id IS NULL AND l.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead % is closed, merged or deleted: no site visits', NEW.lead_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.site_visit_lead_open_guard() FROM PUBLIC;
CREATE TRIGGER site_visit_lead_open_guard BEFORE INSERT ON site_visit
  FOR EACH ROW EXECUTE FUNCTION app.site_visit_lead_open_guard();

-- Won/Lost may not leave an open visit on the lead (the application cancels them first, in the
-- stage change's transaction, as for tasks).
CREATE FUNCTION app.lead_closed_visit_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.stage IN ('WON', 'LOST') AND NEW.stage IS DISTINCT FROM OLD.stage THEN
    PERFORM 1 FROM public.site_visit v
      WHERE v.lead_id = NEW.id AND v.status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED');
    IF FOUND THEN
      RAISE EXCEPTION 'lead % still has open site visits; close them with the stage change', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lead_closed_visit_guard() FROM PUBLIC;
CREATE TRIGGER lead_closed_visit_guard AFTER UPDATE OF stage ON lead
  FOR EACH ROW EXECUTE FUNCTION app.lead_closed_visit_guard();

-- Timeline entries for visits; notifications for visit reminders.
ALTER TABLE lead_activity DROP CONSTRAINT lead_activity_type;
ALTER TABLE lead_activity
  ADD CONSTRAINT lead_activity_type CHECK (type IN ('CREATED', 'ENQUIRY', 'ASSIGNED', 'STAGE',
    'NOTE', 'FIELD_CHANGED', 'ARCHIVED', 'RESTORED', 'MERGED', 'TASK', 'CONTACT_STATUS',
    'INTERACTION', 'SITE_VISIT'));
ALTER TABLE notification DROP CONSTRAINT notification_type;
ALTER TABLE notification
  ADD CONSTRAINT notification_type CHECK (type IN
    ('LEAD_ASSIGNED', 'LEADS_ASSIGNED_DIGEST', 'LEADS_REASSIGNED_AWAY', 'LEAD_RETURNING_ENQUIRY',
     'IMPORT_FINISHED', 'TASK_ASSIGNED', 'MEETING_INVITED', 'TASK_REMINDER', 'VISIT_REMINDER'));
ALTER TABLE notification
  ADD CONSTRAINT notification_visit_reminder_data CHECK (type <> 'VISIT_REMINDER'
    OR (data ? 'siteVisitId' AND (data ->> 'siteVisitId') ~ '^[0-9a-f-]{36}$'));

-- RLS: ENABLE + FORCE, migrator maintenance, crm_app tenant isolation, and RESTRICTIVE role
-- policies (§4.3: sales roles only; HR none). Lead scope is applied by the application.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_visit', 'site_visit_event'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY maintenance ON %I FOR ALL TO crm_migrator USING (true) WITH CHECK (true)', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO crm_app '
      'USING (org_id = (SELECT app.current_org_id())) '
      'WITH CHECK (org_id = (SELECT app.current_org_id()))', t);
    EXECUTE format(
      'CREATE POLICY role_sales ON %I AS RESTRICTIVE FOR ALL TO crm_app '
      'USING ((SELECT app.current_member_role()) IN (''owner'', ''admin'', ''sales_manager'', ''sales_executive'') '
      '  OR (SELECT app.current_user_id()) IS NULL) '
      'WITH CHECK ((SELECT app.current_member_role()) IN (''owner'', ''admin'', ''sales_manager'', ''sales_executive''))', t);
  END LOOP;
END $$;
CREATE POLICY actor_is_session_user ON site_visit AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (scheduled_by = (SELECT app.current_user_id()) AND created_at = now()
    AND status = 'SCHEDULED' AND reschedule_count = 0 AND version = 1);
CREATE POLICY actor_is_session_user ON site_visit_event AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (actor_id = (SELECT app.current_user_id()) AND occurred_at = now());
GRANT SELECT, INSERT ON site_visit TO crm_app;
GRANT UPDATE (lead_id, scheduled_for, location_text, status, reschedule_count, cancel_reason,
  no_show_reason, attended_at, interest_level, objections, outcome_notes, next_action, closed_at,
  version, updated_at) ON site_visit TO crm_app;
GRANT SELECT, INSERT ON site_visit_event TO crm_app;

-- FR-150 reminders: 15 minutes before the visit (the FR-106 default), for the assignee and the
-- person who scheduled it. One per visit, recipient, offset and fire time (a reschedule is a new key).
CREATE TABLE "site_visit_reminder" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "site_visit_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "offset_minutes" INTEGER NOT NULL,
    "fire_at" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_visit_reminder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_visit_reminder_org_id_id_key" ON "site_visit_reminder"("org_id", "id");
CREATE UNIQUE INDEX "site_visit_reminder_key" ON "site_visit_reminder"("site_visit_id", "recipient_user_id", "offset_minutes", "fire_at");
ALTER TABLE "site_visit_reminder" ADD CONSTRAINT "site_visit_reminder_org_id_site_visit_id_fkey" FOREIGN KEY ("org_id", "site_visit_id") REFERENCES "site_visit"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE site_visit_reminder
  ADD CONSTRAINT site_visit_reminder_fire_at CHECK (fire_at = scheduled_for - make_interval(mins => offset_minutes));
ALTER TABLE site_visit_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_visit_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON site_visit_reminder FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON site_visit_reminder FOR SELECT TO crm_app
  USING (org_id = (SELECT app.current_org_id()));
GRANT SELECT ON site_visit_reminder TO crm_app;
CREATE POLICY definer_reminders ON site_visit_reminder FOR ALL TO crm_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON site_visit_reminder TO crm_definer;
CREATE POLICY definer_reminder_scan ON site_visit FOR SELECT TO crm_definer
  USING (status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED'));
GRANT SELECT (id, org_id, status, scheduled_for, assigned_user_id, scheduled_by) ON site_visit TO crm_definer;

CREATE FUNCTION app.site_visit_reminders_claim(p_limit integer DEFAULT 200, p_offset_minutes integer DEFAULT 15)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    WITH due AS (
      SELECT v.org_id, v.id, v.scheduled_for, r.recipient
        FROM public.site_visit v
        CROSS JOIN LATERAL (SELECT DISTINCT unnest(ARRAY[v.assigned_user_id, v.scheduled_by]) AS recipient) r
       WHERE v.status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED')
         AND v.scheduled_for > now()
         AND v.scheduled_for <= now() + make_interval(mins => p_offset_minutes)
         AND NOT EXISTS (
           SELECT 1 FROM public.site_visit_reminder x
            WHERE x.site_visit_id = v.id AND x.recipient_user_id = r.recipient
              AND x.offset_minutes = p_offset_minutes
              AND x.fire_at = v.scheduled_for - make_interval(mins => p_offset_minutes))
       ORDER BY v.scheduled_for
       LIMIT least(greatest(p_limit, 1), 1000)
    ), ins AS (
      INSERT INTO public.site_visit_reminder (org_id, site_visit_id, recipient_user_id, offset_minutes, fire_at, scheduled_for)
      SELECT d.org_id, d.id, d.recipient, p_offset_minutes,
             d.scheduled_for - make_interval(mins => p_offset_minutes), d.scheduled_for
        FROM due d
      ON CONFLICT (site_visit_id, recipient_user_id, offset_minutes, fire_at) DO NOTHING
      RETURNING org_id, site_visit_id, recipient_user_id, scheduled_for
    ), ev AS (
      INSERT INTO public.outbox_event (org_id, type, payload)
      SELECT i.org_id, 'site_visit.reminder_due',
             jsonb_build_object('siteVisitId', i.site_visit_id, 'recipientUserId', i.recipient_user_id,
                                'scheduledFor', i.scheduled_for)
        FROM ins i
      RETURNING 1
    )
    SELECT count(*)::integer FROM ev
  $$;
ALTER FUNCTION app.site_visit_reminders_claim(integer, integer) OWNER TO crm_definer;
REVOKE ALL ON FUNCTION app.site_visit_reminders_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.site_visit_reminders_claim(integer, integer) TO crm_app;
