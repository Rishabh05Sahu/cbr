-- Phase 4, FR-103: tasks for other people (ADR-0016). Role matrix §4.3 "task.create for others":
-- Owner O, Admin O, Sales Manager T (members of the teams they lead), Sales Executive and HR
-- none. Acceptance: "Assignee notified".
--
--   * The RESTRICTIVE insert policy of 0012 required assignee = creator. It is replaced with the
--     same checks plus app.task_assignee_allowed(): the session user themself, or an ACTIVE member
--     of the org when the session member is Owner/Admin, or an ACTIVE member currently in a
--     non-archived team the session member leads when they are a Sales Manager. The application
--     applies the same rule and also requires that the assignee could work on the task (lead
--     access for a lead task), which the database does not model.
--   * Notifications: a new in-app type TASK_ASSIGNED, written by the worker from the outbox event
--     'task.assigned' (same pattern as 0004/0010). One per task and recipient.
-- The task table, its other policies, grants and triggers are unchanged. No existing migration is
-- rewritten.

-- SECURITY INVOKER: reads memberships and teams as crm_app under their tenant policies.
CREATE FUNCTION app.task_assignee_allowed(p_assignee uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT p_assignee = app.current_user_id()
      OR EXISTS (
        SELECT 1 FROM public.organization_membership a
         WHERE a.org_id = app.current_org_id() AND a.user_id = p_assignee AND a.status = 'ACTIVE'
           AND (app.current_member_role() IN ('owner', 'admin')
             OR (app.current_member_role() = 'sales_manager' AND EXISTS (
               SELECT 1
                 FROM public.team_membership am
                 JOIN public.team t ON t.id = am.team_id AND t.archived_at IS NULL
                 JOIN public.team_membership lm
                   ON lm.team_id = am.team_id AND lm.team_role = 'LEAD' AND lm.ended_at IS NULL
                 JOIN public.organization_membership me
                   ON me.id = lm.membership_id AND me.org_id = app.current_org_id()
                  AND me.user_id = app.current_user_id()
                WHERE am.membership_id = a.id AND am.ended_at IS NULL))))
  $$;
REVOKE ALL ON FUNCTION app.task_assignee_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.task_assignee_allowed(uuid) TO crm_app;

DROP POLICY actor_is_session_user ON task;
CREATE POLICY actor_is_session_user ON task AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (created_by = (SELECT app.current_user_id())
    AND (SELECT app.task_assignee_allowed(assignee_user_id))
    AND created_at = now() AND status = 'OPEN' AND reschedule_count = 0 AND version = 1
    AND due_at >= now() - interval '5 minutes');

ALTER TABLE notification DROP CONSTRAINT notification_type;
ALTER TABLE notification
  ADD CONSTRAINT notification_type CHECK (type IN
    ('LEAD_ASSIGNED', 'LEADS_ASSIGNED_DIGEST', 'LEADS_REASSIGNED_AWAY', 'LEAD_RETURNING_ENQUIRY',
     'IMPORT_FINISHED', 'TASK_ASSIGNED'));
ALTER TABLE notification
  ADD CONSTRAINT notification_task_assigned_data CHECK (type <> 'TASK_ASSIGNED'
    OR (data ? 'taskId' AND (data ->> 'taskId') ~ '^[0-9a-f-]{36}$'));
CREATE UNIQUE INDEX notification_task_assigned_uq
  ON notification (org_id, recipient_user_id, (data ->> 'taskId'))
  WHERE type = 'TASK_ASSIGNED';
