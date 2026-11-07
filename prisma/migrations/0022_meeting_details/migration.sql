-- Phase 4, FR-104: meeting details (ADR-0017). "Meetings: start/end, location or link, attendees
-- (internal), linked lead"; acceptance "Overlap warning for same user". Domain model §2.6:
-- meetings are tasks of type MEETING with end_at, location and attendees (TaskAttendee).
--
-- Owner decisions 2026-10-30:
--   * The end time is required for new meetings and whenever a meeting's details are edited (the
--     application enforces "required"; existing start-only meetings stay valid until edited).
--   * Any active member of the org may be invited; an invitation gives no lead access.
--   * Attendees see the meeting read-only on their My Day (application) and get one in-app
--     notification per meeting (worker, event 'meeting.invited').
-- The overlap warning is computed by the application and never blocks a save. Start (due_at),
-- ownership, assignment (0021), DNC (0020) and lifecycle rules are unchanged. No existing
-- migration is rewritten.

ALTER TABLE task ADD COLUMN end_at TIMESTAMPTZ(6), ADD COLUMN location TEXT;
ALTER TABLE task
  -- Only meetings have an end time or a location; other types are untouched.
  ADD CONSTRAINT task_meeting_fields CHECK (type = 'MEETING' OR (end_at IS NULL AND location IS NULL)),
  ADD CONSTRAINT task_end_after_start CHECK (end_at IS NULL OR (end_at > due_at AND end_at <= due_at + interval '24 hours')),
  ADD CONSTRAINT task_location CHECK (location IS NULL OR (length(location) BETWEEN 1 AND 300 AND location = btrim(location)));
GRANT UPDATE (end_at, location) ON task TO crm_app;

-- Attendees. A removal is recorded (removed_at/removed_by), never deleted, so the history of who
-- was invited stays. One current invitation per meeting and person.
CREATE TABLE "task_attendee" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by" UUID,

    CONSTRAINT "task_attendee_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "task_attendee_org_id_id_key" ON "task_attendee"("org_id", "id");
CREATE UNIQUE INDEX task_attendee_current_uq ON task_attendee (task_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX "task_attendee_org_id_user_id_idx" ON "task_attendee"("org_id", "user_id") WHERE removed_at IS NULL;
ALTER TABLE "task_attendee" ADD CONSTRAINT "task_attendee_org_id_task_id_fkey" FOREIGN KEY ("org_id", "task_id") REFERENCES "task"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "task_attendee" ADD CONSTRAINT "task_attendee_org_id_user_id_fkey" FOREIGN KEY ("org_id", "user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "task_attendee" ADD CONSTRAINT "task_attendee_org_id_added_by_fkey" FOREIGN KEY ("org_id", "added_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "task_attendee" ADD CONSTRAINT "task_attendee_org_id_removed_by_fkey" FOREIGN KEY ("org_id", "removed_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE task_attendee
  ADD CONSTRAINT task_attendee_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL));

-- An invitation is to an OPEN meeting, for an ACTIVE member who is not its assignee; a removal
-- happens only while the meeting is open and is final. Runs under RLS as the session role.
CREATE FUNCTION app.task_attendee_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.removed_at IS NOT NULL OR NEW.task_id <> OLD.task_id OR NEW.user_id <> OLD.user_id
       OR NEW.added_by <> OLD.added_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'attendee % can only be removed, once', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM 1 FROM public.task t WHERE t.id = NEW.task_id AND t.type = 'MEETING' AND t.status = 'OPEN'
    AND (TG_OP = 'UPDATE' OR t.assignee_user_id <> NEW.user_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attendees belong to an open meeting and are not its assignee'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM public.organization_membership m
      WHERE m.org_id = NEW.org_id AND m.user_id = NEW.user_id AND m.status = 'ACTIVE';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'attendee % is not an active member', NEW.user_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.task_attendee_guard() FROM PUBLIC;
CREATE TRIGGER task_attendee_guard BEFORE INSERT OR UPDATE ON task_attendee
  FOR EACH ROW EXECUTE FUNCTION app.task_attendee_guard();

-- RLS: ENABLE + FORCE, migrator maintenance, crm_app tenant isolation (as 0012).
ALTER TABLE task_attendee ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_attendee FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON task_attendee FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON task_attendee FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
-- RESTRICTIVE: an invitation is made by the session user, now; a removal is by the session user.
CREATE POLICY actor_is_session_user ON task_attendee AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (added_by = (SELECT app.current_user_id()) AND created_at = now()
    AND removed_at IS NULL AND removed_by IS NULL);
CREATE POLICY remover_is_session_user ON task_attendee AS RESTRICTIVE FOR UPDATE TO crm_app
  USING (true)
  WITH CHECK (removed_by = (SELECT app.current_user_id()) AND removed_at = now());
GRANT SELECT, INSERT ON task_attendee TO crm_app;
GRANT UPDATE (removed_at, removed_by) ON task_attendee TO crm_app;

-- Notifications: one MEETING_INVITED per meeting and recipient (same pattern as 0021).
ALTER TABLE notification DROP CONSTRAINT notification_type;
ALTER TABLE notification
  ADD CONSTRAINT notification_type CHECK (type IN
    ('LEAD_ASSIGNED', 'LEADS_ASSIGNED_DIGEST', 'LEADS_REASSIGNED_AWAY', 'LEAD_RETURNING_ENQUIRY',
     'IMPORT_FINISHED', 'TASK_ASSIGNED', 'MEETING_INVITED'));
ALTER TABLE notification
  ADD CONSTRAINT notification_meeting_invited_data CHECK (type <> 'MEETING_INVITED'
    OR (data ? 'taskId' AND (data ->> 'taskId') ~ '^[0-9a-f-]{36}$'));
CREATE UNIQUE INDEX notification_meeting_invited_uq
  ON notification (org_id, recipient_user_id, (data ->> 'taskId'))
  WHERE type = 'MEETING_INVITED';
