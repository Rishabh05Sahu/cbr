-- Phase 3: the rest of FR-100 (ADR-0015). Besides follow-ups, members create Call, Meeting,
-- Document and Other tasks for themselves, on a lead or with no lead. The task table, its
-- RLS, grants, task_guard and the FR-108 follow-up rules (one open follow-up per lead and
-- person, lead.next_follow_up_at) are unchanged from 0012/0013.
--
-- Owner decisions 2026-10-29:
--   * A lead task of any type follows the follow-up lifecycle (ADR-0010): it moves with the
--     lead's owner and is cancelled when the lead is Won or Lost. The application cancels them
--     in the stage change's transaction; lead_closed_follow_up_guard is replaced so the database
--     refuses a Won/Lost change that leaves ANY open task on the lead (it checked follow-ups only).
--   * A no-lead task is cancelled with a reason when its assignee is deactivated (application;
--     membership_open_tasks_guard already refuses deactivation while any open task remains).
--   * A new Call task is refused on a Do-Not-Contact lead (task_call_dnc_guard). Existing tasks
--     are not changed when a lead becomes Do-Not-Contact.
--   * Meeting is a task type with a title and a start time only; end time, location and
--     attendees are FR-104 (Phase 4).
-- No existing migration is rewritten.

-- Existing data must satisfy the new rules (only follow-ups could be created before this).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM task WHERE type <> 'FOLLOW_UP' AND title IS NULL) THEN
    RAISE EXCEPTION '0020: tasks other than follow-ups without a title exist';
  END IF;
  IF EXISTS (SELECT 1 FROM task t JOIN lead l ON l.id = t.lead_id
              WHERE t.status = 'OPEN' AND l.stage IN ('WON', 'LOST')) THEN
    RAISE EXCEPTION '0020: open tasks exist on Won/Lost leads; resolve them before migrating';
  END IF;
END $$;

-- A task other than a follow-up says what it is about (a follow-up's title stays optional).
ALTER TABLE task
  ADD CONSTRAINT task_title_required CHECK (type = 'FOLLOW_UP' OR title IS NOT NULL);

-- Same as 0013, for every task type: Won/Lost may not leave an open task on the lead.
CREATE OR REPLACE FUNCTION app.lead_closed_follow_up_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.stage IN ('WON', 'LOST') AND NEW.stage IS DISTINCT FROM OLD.stage THEN
    PERFORM 1 FROM public.task t WHERE t.lead_id = NEW.id AND t.status = 'OPEN';
    IF FOUND THEN
      RAISE EXCEPTION 'lead % still has open tasks; close them with the stage change', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- A Call task plans outbound contact, which a Do-Not-Contact lead refuses (ADR-0012). Runs as
-- the session role under RLS, like task_lead_open_guard; a lead it cannot see fails the FK.
CREATE FUNCTION app.task_call_dnc_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.type = 'CALL' AND NEW.lead_id IS NOT NULL THEN
    PERFORM 1 FROM public.lead l
      WHERE l.id = NEW.lead_id AND l.contact_status = 'DO_NOT_CONTACT';
    IF FOUND THEN
      RAISE EXCEPTION 'lead % is do-not-contact: no call tasks', NEW.lead_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.task_call_dnc_guard() FROM PUBLIC;
CREATE TRIGGER task_call_dnc_guard BEFORE INSERT ON task
  FOR EACH ROW EXECUTE FUNCTION app.task_call_dnc_guard();
