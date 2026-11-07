-- Phase 4, FR-106: task reminders (ADR-0019). "Reminders at configurable offsets (default 15 min
-- before) via in-app and push/email"; acceptance "Exactly one reminder per task per offset
-- (idempotent job key)". Workflow C: the reminder goes to the assignee; a reschedule changes
-- due_at and the key includes due_at, so the old reminder is stale and a new one is due.
--
-- Postgres is the source of truth (ADR-0005; domain model: TaskReminder is "the idempotency
-- anchor"). The worker calls app.task_reminders_claim() every 30 s. In ONE statement it records a
-- task_reminder row per due reminder (unique per task, offset and fire time) and writes an outbox
-- event 'task.reminder_due' for each row it inserted. The existing relay and notification worker
-- turn the event into one in-app notification for the task's current assignee, re-checking the
-- task first. A repeated or concurrent claim inserts nothing twice (ON CONFLICT DO NOTHING), and a
-- redelivered event is deduplicated per (event, recipient) as for every notification.
--
-- Only the default 15-minute offset exists: who configures other offsets is not specified (see
-- ADR-0019). In-app only: push/email channels are FR-119. No existing migration is rewritten.

CREATE TABLE "task_reminder" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "offset_minutes" INTEGER NOT NULL,
    "fire_at" TIMESTAMPTZ(6) NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_reminder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "task_reminder_org_id_id_key" ON "task_reminder"("org_id", "id");
-- The idempotency key (system-architecture §5: rem:{taskId}:{offset}:{dueAt}).
CREATE UNIQUE INDEX "task_reminder_task_id_offset_minutes_fire_at_key"
  ON "task_reminder"("task_id", "offset_minutes", "fire_at");
ALTER TABLE "task_reminder" ADD CONSTRAINT "task_reminder_org_id_task_id_fkey" FOREIGN KEY ("org_id", "task_id") REFERENCES "task"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE task_reminder
  ADD CONSTRAINT task_reminder_offset CHECK (offset_minutes BETWEEN 1 AND 10080),
  ADD CONSTRAINT task_reminder_fire_at CHECK (fire_at = due_at - make_interval(mins => offset_minutes));

-- The claim scans open tasks by due time across orgs.
CREATE INDEX task_open_due_at_idx ON task (due_at) WHERE status = 'OPEN';

-- RLS: crm_app reads its own org's reminders (no writes); crm_definer writes them in the claim.
ALTER TABLE task_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON task_reminder FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON task_reminder FOR SELECT TO crm_app
  USING (org_id = (SELECT app.current_org_id()));
GRANT SELECT ON task_reminder TO crm_app;

CREATE POLICY definer_reminders ON task_reminder FOR ALL TO crm_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON task_reminder TO crm_definer;
CREATE POLICY definer_reminder_scan ON task FOR SELECT TO crm_definer USING (status = 'OPEN');
GRANT SELECT (id, org_id, status, due_at) ON task TO crm_definer;
-- definer_relay (0002) already lets crm_definer use outbox_event; it may now also insert.
GRANT INSERT (org_id, type, payload) ON outbox_event TO crm_definer;

-- Records and announces the reminders that are due now: open tasks whose fire time has passed and
-- whose due time has not (a reminder after the task is due would be noise; it is overdue on My
-- Day instead). Returns how many were recorded. Bounded per call.
CREATE FUNCTION app.task_reminders_claim(p_limit integer DEFAULT 200, p_offset_minutes integer DEFAULT 15)
  RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    WITH due AS (
      SELECT t.org_id, t.id, t.due_at
        FROM public.task t
       WHERE t.status = 'OPEN'
         AND t.due_at > now()
         AND t.due_at <= now() + make_interval(mins => p_offset_minutes)
         AND NOT EXISTS (
           SELECT 1 FROM public.task_reminder r
            WHERE r.task_id = t.id AND r.offset_minutes = p_offset_minutes
              AND r.fire_at = t.due_at - make_interval(mins => p_offset_minutes))
       ORDER BY t.due_at
       LIMIT least(greatest(p_limit, 1), 1000)
    ), ins AS (
      INSERT INTO public.task_reminder (org_id, task_id, offset_minutes, fire_at, due_at)
      SELECT d.org_id, d.id, p_offset_minutes, d.due_at - make_interval(mins => p_offset_minutes), d.due_at
        FROM due d
      ON CONFLICT (task_id, offset_minutes, fire_at) DO NOTHING
      RETURNING org_id, task_id, offset_minutes, fire_at, due_at
    ), ev AS (
      INSERT INTO public.outbox_event (org_id, type, payload)
      SELECT i.org_id, 'task.reminder_due',
             jsonb_build_object('taskId', i.task_id, 'offsetMinutes', i.offset_minutes,
                                'dueAt', i.due_at, 'fireAt', i.fire_at)
        FROM ins i
      RETURNING 1
    )
    SELECT count(*)::integer FROM ev
  $$;
ALTER FUNCTION app.task_reminders_claim(integer, integer) OWNER TO crm_definer;
REVOKE ALL ON FUNCTION app.task_reminders_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.task_reminders_claim(integer, integer) TO crm_app;

-- Notifications: TASK_REMINDER, one per reminder event and recipient (0004's unique index), and
-- display-safe data only.
ALTER TABLE notification DROP CONSTRAINT notification_type;
ALTER TABLE notification
  ADD CONSTRAINT notification_type CHECK (type IN
    ('LEAD_ASSIGNED', 'LEADS_ASSIGNED_DIGEST', 'LEADS_REASSIGNED_AWAY', 'LEAD_RETURNING_ENQUIRY',
     'IMPORT_FINISHED', 'TASK_ASSIGNED', 'MEETING_INVITED', 'TASK_REMINDER'));
ALTER TABLE notification
  ADD CONSTRAINT notification_task_reminder_data CHECK (type <> 'TASK_REMINDER'
    OR (data ? 'taskId' AND (data ->> 'taskId') ~ '^[0-9a-f-]{36}$'));
