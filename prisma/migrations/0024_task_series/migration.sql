-- Phase 4, FR-107: recurring tasks (ADR-0020). "Recurring tasks (daily/weekly) for non-lead
-- tasks." Owner rules 2026-10-30:
--   * Only no-lead Call, Meeting, Document and Other tasks; never follow-ups.
--   * Only Sales Managers, Owners and Admins create a series, and its tasks are assigned to its
--     creator (no recurring assignment to others). No-lead privacy is unchanged.
--   * Daily at a fixed org-local time, or weekly on one weekday at that time. An optional end date
--     is inclusive (org-local).
--   * The next occurrence is created when the current one is completed or cancelled, strictly
--     after that moment (missed dates are skipped, no backlog). Cancelling one occurrence skips it;
--     stopping the series prevents further occurrences and leaves the current task alone.
--   * Editing changes future occurrences only. Each occurrence is an ordinary task (its own id,
--     lifecycle and FR-106 reminder). A recurring meeting keeps its length, location and attendees.
--
-- task_series holds the template; task.series_id links each occurrence. At most ONE open task per
-- series (task_series_open_uq), so concurrent completions or retries cannot create two next
-- occurrences. No existing migration is rewritten.

CREATE TABLE "task_series" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "frequency" TEXT NOT NULL,
    "weekday" INTEGER,
    "local_time" TEXT NOT NULL,
    "end_date" DATE,
    "duration_minutes" INTEGER,
    "location" TEXT,
    "attendee_user_ids" UUID[] NOT NULL DEFAULT '{}',
    "stopped_at" TIMESTAMPTZ(6),
    "stopped_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_series_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "task_series_org_id_id_key" ON "task_series"("org_id", "id");
CREATE INDEX "task_series_org_id_owner_user_id_idx" ON "task_series"("org_id", "owner_user_id");
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_org_id_owner_user_id_fkey" FOREIGN KEY ("org_id", "owner_user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_org_id_created_by_fkey" FOREIGN KEY ("org_id", "created_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "task_series" ADD CONSTRAINT "task_series_org_id_stopped_by_fkey" FOREIGN KEY ("org_id", "stopped_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE task_series
  ADD CONSTRAINT task_series_type CHECK (type IN ('CALL', 'MEETING', 'DOCUMENT', 'OTHER')),
  ADD CONSTRAINT task_series_title CHECK (length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  ADD CONSTRAINT task_series_priority CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  ADD CONSTRAINT task_series_frequency CHECK (
    (frequency = 'DAILY' AND weekday IS NULL)
    OR (frequency = 'WEEKLY' AND weekday BETWEEN 0 AND 6)),
  ADD CONSTRAINT task_series_local_time CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT task_series_meeting CHECK (
    (type = 'MEETING' AND duration_minutes BETWEEN 1 AND 1440)
    OR (type <> 'MEETING' AND duration_minutes IS NULL AND location IS NULL
        AND cardinality(attendee_user_ids) = 0)),
  ADD CONSTRAINT task_series_location CHECK (location IS NULL OR (length(location) BETWEEN 1 AND 300 AND location = btrim(location))),
  ADD CONSTRAINT task_series_attendees CHECK (cardinality(attendee_user_ids) <= 30),
  ADD CONSTRAINT task_series_stopped CHECK ((stopped_at IS NULL) = (stopped_by IS NULL)),
  ADD CONSTRAINT task_series_version CHECK (version >= 1);

-- A stopped series stays stopped; the owner and creator never change.
CREATE FUNCTION app.task_series_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.stopped_at IS NOT NULL THEN
    RAISE EXCEPTION 'series % is stopped and cannot change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'series % version must increase', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.stopped_at IS NOT NULL AND NEW.stopped_at <> now() THEN
    RAISE EXCEPTION 'series % stop time must be now', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.task_series_guard() FROM PUBLIC;
CREATE TRIGGER task_series_guard BEFORE UPDATE ON task_series
  FOR EACH ROW EXECUTE FUNCTION app.task_series_guard();

-- Occurrences: ordinary tasks linked to their series; no lead, never a follow-up; one open each.
ALTER TABLE task ADD COLUMN series_id UUID;
ALTER TABLE task ADD CONSTRAINT task_org_id_series_id_fkey FOREIGN KEY (org_id, series_id) REFERENCES task_series (org_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE task ADD CONSTRAINT task_series_no_lead CHECK (series_id IS NULL OR (lead_id IS NULL AND type <> 'FOLLOW_UP'));
CREATE UNIQUE INDEX task_series_open_uq ON task (series_id) WHERE status = 'OPEN' AND series_id IS NOT NULL;
CREATE INDEX task_series_id_idx ON task (series_id) WHERE series_id IS NOT NULL;

-- RLS (as 0012): tenant isolation; a series is created by the session user for themself, by an
-- Owner, Admin or Sales Manager (role matrix decision 2026-10-30), open and at version 1.
ALTER TABLE task_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_series FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON task_series FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON task_series FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
CREATE POLICY actor_is_session_user ON task_series AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (created_by = (SELECT app.current_user_id())
    AND owner_user_id = (SELECT app.current_user_id())
    AND (SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager')
    AND stopped_at IS NULL AND version = 1 AND created_at = now());
GRANT SELECT, INSERT ON task_series TO crm_app;
GRANT UPDATE (title, priority, frequency, weekday, local_time, end_date, duration_minutes, location,
  attendee_user_ids, stopped_at, stopped_by, version, updated_at) ON task_series TO crm_app;
