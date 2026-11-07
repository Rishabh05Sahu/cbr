-- Phase 3, slice 2: follow-up lifecycle consistency (ADR-0010).
--   * FR-077 / workflow G: open follow-ups follow a lead to its new owner and leave a deactivated
--     member. crm_app may now change task.assignee_user_id; the new assignee must be an ACTIVE
--     member of the org (task_guard).
--   * Won/Lost: a closed lead has no open follow-ups. The application cancels them in the same
--     transaction as the stage change; the database refuses a stage change that would leave one
--     open, and a follow-up created on a closed lead.
--   * A member cannot be deactivated while open tasks are still assigned to them.
-- No existing migration, policy or grant is rewritten; task_guard is replaced with the same
-- checks plus the assignee rule.

-- Existing data must already satisfy the new rules (none expected: follow-ups are new in 0012).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM task t JOIN lead l ON l.id = t.lead_id
              WHERE t.status = 'OPEN' AND t.type = 'FOLLOW_UP' AND l.stage IN ('WON', 'LOST')) THEN
    RAISE EXCEPTION '0013: open follow-ups exist on Won/Lost leads; resolve them before migrating';
  END IF;
  IF EXISTS (SELECT 1 FROM task t JOIN organization_membership m
                ON m.org_id = t.org_id AND m.user_id = t.assignee_user_id
              WHERE t.status = 'OPEN' AND m.status = 'DEACTIVATED') THEN
    RAISE EXCEPTION '0013: open tasks are assigned to deactivated members; resolve them before migrating';
  END IF;
END $$;

GRANT UPDATE (assignee_user_id) ON task TO crm_app;

-- Same checks as 0012, plus: a handover only goes to an ACTIVE member of the same org.
CREATE OR REPLACE FUNCTION app.task_guard() RETURNS trigger
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
  IF NEW.assignee_user_id <> OLD.assignee_user_id THEN
    PERFORM 1 FROM public.organization_membership m
      WHERE m.org_id = NEW.org_id AND m.user_id = NEW.assignee_user_id AND m.status = 'ACTIVE';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'task % can only be handed to an active member', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A follow-up is created only on a live, open lead (not Won/Lost, merged or deleted).
CREATE FUNCTION app.task_lead_open_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NEW.status = 'OPEN' THEN
    PERFORM 1 FROM public.lead l
      WHERE l.id = NEW.lead_id AND l.stage NOT IN ('WON', 'LOST')
        AND l.merged_into_lead_id IS NULL AND l.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'lead % is closed, merged or deleted: no open follow-ups', NEW.lead_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.task_lead_open_guard() FROM PUBLIC;
CREATE TRIGGER task_lead_open_guard BEFORE INSERT ON task
  FOR EACH ROW EXECUTE FUNCTION app.task_lead_open_guard();

-- Moving a lead to Won or Lost with an open follow-up left is refused: the transition and the
-- cancellations commit together or not at all.
CREATE FUNCTION app.lead_closed_follow_up_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.stage IN ('WON', 'LOST') AND NEW.stage IS DISTINCT FROM OLD.stage THEN
    PERFORM 1 FROM public.task t
      WHERE t.lead_id = NEW.id AND t.status = 'OPEN' AND t.type = 'FOLLOW_UP';
    IF FOUND THEN
      RAISE EXCEPTION 'lead % still has open follow-ups; close them with the stage change', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.lead_closed_follow_up_guard() FROM PUBLIC;
CREATE TRIGGER lead_closed_follow_up_guard AFTER UPDATE OF stage ON lead
  FOR EACH ROW EXECUTE FUNCTION app.lead_closed_follow_up_guard();

-- FR-077: deactivation is refused while open tasks are still assigned to the member (they are
-- handed over first, in the same transaction). Runs only for that transition.
CREATE FUNCTION app.membership_open_tasks_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.status = 'DEACTIVATED' AND OLD.status IS DISTINCT FROM 'DEACTIVATED' THEN
    PERFORM 1 FROM public.task t
      WHERE t.org_id = NEW.org_id AND t.assignee_user_id = NEW.user_id AND t.status = 'OPEN';
    IF FOUND THEN
      RAISE EXCEPTION 'member % still has open tasks; hand them over first', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.membership_open_tasks_guard() FROM PUBLIC;
CREATE TRIGGER membership_open_tasks_guard BEFORE UPDATE OF status ON organization_membership
  FOR EACH ROW EXECUTE FUNCTION app.membership_open_tasks_guard();
