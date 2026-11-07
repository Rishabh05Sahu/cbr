-- Phase 3, first slice: lead follow-ups (FR-100 task base, FR-102 complete/cancel/reschedule,
-- FR-108 next follow-up). The task table follows domain-model §2.6; this slice creates only
-- FOLLOW_UP tasks, always on a lead and assigned to their creator (creating tasks for others is
-- FR-103, Phase 4). Reminders, escalations and My Day are later slices.
--
-- Same conventions as 0003/0005/0011: org-scoped composite foreign keys, RLS enabled and forced,
-- migrator maintenance, crm_app tenant isolation, RESTRICTIVE insert policies stamping the
-- session user and the transaction time, and column-level UPDATE grants. No DELETE: a task is
-- closed by status (database-design: "Status-based close").
--
-- FR-108: at most one OPEN follow-up per lead per assignee (a partial unique index), so each
-- open follow-up is its assignee's primary one. lead.next_follow_up_at is the earliest due_at of
-- the lead's open follow-ups. It is derived: only the sync trigger below may change it, in the
-- same transaction as the task change (lead-lifecycle §4 "Maintained transactionally").

CREATE TABLE "task" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'FOLLOW_UP',
    "title" TEXT,
    "lead_id" UUID,
    "assignee_user_id" UUID NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "reschedule_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_org_id_id_key" ON "task"("org_id", "id");
CREATE INDEX "task_org_id_lead_id_status_idx" ON "task"("org_id", "lead_id", "status");
CREATE INDEX "task_org_id_assignee_user_id_status_due_at_idx" ON "task"("org_id", "assignee_user_id", "status", "due_at");

ALTER TABLE "task" ADD CONSTRAINT "task_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "task" ADD CONSTRAINT "task_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "task" ADD CONSTRAINT "task_org_id_assignee_user_id_fkey" FOREIGN KEY ("org_id", "assignee_user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "task" ADD CONSTRAINT "task_org_id_created_by_fkey" FOREIGN KEY ("org_id", "created_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE task
  ADD CONSTRAINT task_type CHECK (type IN ('FOLLOW_UP', 'CALL', 'MEETING', 'DOCUMENT', 'OTHER')),
  ADD CONSTRAINT task_follow_up_lead CHECK (type <> 'FOLLOW_UP' OR lead_id IS NOT NULL),
  ADD CONSTRAINT task_priority CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  ADD CONSTRAINT task_title CHECK (title IS NULL OR (length(title) BETWEEN 1 AND 200 AND title = btrim(title))),
  ADD CONSTRAINT task_cancel_reason CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  ADD CONSTRAINT task_reschedule_count CHECK (reschedule_count >= 0),
  ADD CONSTRAINT task_version CHECK (version >= 1),
  -- One consistent state: no completion time on a cancelled task, no reason on a done one, etc.
  ADD CONSTRAINT task_status CHECK (
    (status = 'OPEN' AND completed_at IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR (status = 'DONE' AND completed_at IS NOT NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND completed_at IS NULL));

-- FR-108: the primary follow-up. A second open follow-up for the same lead and assignee is
-- refused; the existing one is rescheduled instead.
CREATE UNIQUE INDEX task_open_follow_up_uq ON task (lead_id, assignee_user_id)
  WHERE status = 'OPEN' AND type = 'FOLLOW_UP';

-- ---------------------------------------------------------------------------
-- lead.next_follow_up_at (lead-lifecycle §4), derived from open follow-ups
-- ---------------------------------------------------------------------------
ALTER TABLE "lead" ADD COLUMN "next_follow_up_at" TIMESTAMPTZ(6);
CREATE INDEX lead_org_next_follow_up_idx ON lead (org_id, next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;

-- Recomputes the earliest open follow-up of the lead(s) a task row belongs to (before and after
-- a move). SECURITY INVOKER: it runs as the session role, under RLS, like the statement itself.
-- An unchanged value is not written, so the lead row is only touched when the date changes.
CREATE FUNCTION app.task_sync_next_follow_up() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ids uuid[] := ARRAY[]::uuid[];
  l uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.lead_id IS NOT NULL THEN ids := ids || OLD.lead_id; END IF;
  IF NEW.lead_id IS NOT NULL AND NOT (NEW.lead_id = ANY (ids)) THEN ids := ids || NEW.lead_id; END IF;
  FOREACH l IN ARRAY ids LOOP
    UPDATE public.lead d
       SET next_follow_up_at = n.due
      FROM (SELECT min(t.due_at) AS due FROM public.task t
             WHERE t.lead_id = l AND t.status = 'OPEN' AND t.type = 'FOLLOW_UP') n
     WHERE d.id = l AND d.next_follow_up_at IS DISTINCT FROM n.due;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.task_sync_next_follow_up() FROM PUBLIC;
CREATE TRIGGER task_sync_next_follow_up AFTER INSERT OR UPDATE OF lead_id, due_at, status, type
  ON task FOR EACH ROW EXECUTE FUNCTION app.task_sync_next_follow_up();

-- The derived column changes only from inside the sync trigger (trigger depth > 1), never by a
-- direct UPDATE of lead, so it cannot drift from the task rows.
CREATE FUNCTION app.lead_next_follow_up_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.next_follow_up_at IS DISTINCT FROM OLD.next_follow_up_at AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'lead % next_follow_up_at is derived from its open follow-ups', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_next_follow_up_guard() FROM PUBLIC;
CREATE TRIGGER lead_next_follow_up_guard BEFORE UPDATE OF next_follow_up_at ON lead
  FOR EACH ROW EXECUTE FUNCTION app.lead_next_follow_up_guard();

-- Task updates (FR-102): a closed task is history and never changes again; reschedules only
-- count up; completion and cancellation are stamped with the transaction time; a new due time
-- is not in the past (5 minutes of slack for slow submits); every change raises the version.
CREATE FUNCTION app.task_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.status <> 'OPEN' THEN
    RAISE EXCEPTION 'task % is % and cannot change', OLD.id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'task % version must increase', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reschedule_count < OLD.reschedule_count THEN
    RAISE EXCEPTION 'task % reschedule count cannot go down', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.due_at IS DISTINCT FROM OLD.due_at AND NEW.due_at < now() - interval '5 minutes' THEN
    RAISE EXCEPTION 'task % cannot be rescheduled into the past', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'DONE' AND NEW.completed_at <> now() THEN
    RAISE EXCEPTION 'task % completion time must be now', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'CANCELLED' AND NEW.cancelled_at <> now() THEN
    RAISE EXCEPTION 'task % cancellation time must be now', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.task_guard() FROM PUBLIC;
CREATE TRIGGER task_guard BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION app.task_guard();

-- Timeline entries for follow-ups (scheduled, rescheduled, completed, cancelled).
ALTER TABLE lead_activity DROP CONSTRAINT lead_activity_type;
ALTER TABLE lead_activity
  ADD CONSTRAINT lead_activity_type CHECK (type IN ('CREATED', 'ENQUIRY', 'ASSIGNED', 'STAGE',
    'NOTE', 'FIELD_CHANGED', 'ARCHIVED', 'RESTORED', 'MERGED', 'TASK'));

-- RLS: ENABLE + FORCE, migrator maintenance, crm_app tenant isolation (same text as 0011).
ALTER TABLE task ENABLE ROW LEVEL SECURITY;
ALTER TABLE task FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON task FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON task FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));

-- RESTRICTIVE: a new task is the session user's own (assignee = creator in Phase 3), open,
-- unrescheduled, created now, and not due in the past.
CREATE POLICY actor_is_session_user ON task AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (created_by = (SELECT app.current_user_id())
    AND assignee_user_id = (SELECT app.current_user_id())
    AND created_at = now() AND status = 'OPEN' AND reschedule_count = 0 AND version = 1
    AND due_at >= now() - interval '5 minutes');

-- crm_app: read, insert, and update the columns a reschedule, completion, cancellation or merge
-- move needs. Type, assignee, creator and creation time never change. Other roles get nothing.
GRANT SELECT, INSERT ON task TO crm_app;
GRANT UPDATE (lead_id, due_at, priority, title, status, completed_at, cancelled_at, cancel_reason,
  reschedule_count, version, updated_at) ON task TO crm_app;
-- Written only by app.task_sync_next_follow_up (lead_next_follow_up_guard refuses direct writes).
GRANT UPDATE (next_follow_up_at) ON lead TO crm_app;
