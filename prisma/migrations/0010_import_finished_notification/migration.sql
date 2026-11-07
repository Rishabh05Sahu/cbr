-- Phase 2 (M4 deferred item): tell the person who started an import that it has finished, in the
-- existing in-app notifications (0004). No email, SMS or push.
--
-- 1. When an import_job moves INTO a finished state (COMPLETED, COMPLETED_WITH_ERRORS, FAILED) from
--    any unfinished one, a trigger writes one outbox event 'import.finished' in the SAME
--    transaction as the status change, whichever code path made it (processor, upload checks,
--    file cleanup). Finished states never change again, so each job emits at most once.
--    CANCELLED (the user's own action) and EXPIRED (never uploaded) are not announced.
-- 2. The worker turns the event into one IMPORT_FINISHED notification for the job's creator
--    (src/modules/notifications). Redelivery is a no-op twice over: (event_id, recipient) is
--    already unique (0004), and the partial unique index below allows one IMPORT_FINISHED
--    notification per import and recipient even if an event were ever duplicated.
--
-- The trigger function is SECURITY INVOKER: it inserts as the session's role under the existing
-- outbox_event policies (crm_app: tenant isolation on NEW.org_id; crm_migrator: maintenance).
-- It is not callable through the Data API (EXECUTE revoked from PUBLIC; anon & co. have no USAGE
-- on schema app).

ALTER TABLE notification DROP CONSTRAINT notification_type;
ALTER TABLE notification
  ADD CONSTRAINT notification_type CHECK (type IN
    ('LEAD_ASSIGNED', 'LEADS_ASSIGNED_DIGEST', 'LEADS_REASSIGNED_AWAY', 'LEAD_RETURNING_ENQUIRY',
     'IMPORT_FINISHED'));

-- One finished-import notification per import and recipient (data.importJobId is written by the
-- worker; display-safe ids and counts only, as for the other types).
ALTER TABLE notification
  ADD CONSTRAINT notification_import_finished_data CHECK (type <> 'IMPORT_FINISHED'
    OR (data ? 'importJobId' AND (data ->> 'importJobId') ~ '^[0-9a-f-]{36}$'));
CREATE UNIQUE INDEX notification_import_finished_uq
  ON notification (org_id, recipient_user_id, (data ->> 'importJobId'))
  WHERE type = 'IMPORT_FINISHED';

CREATE FUNCTION app.import_finished_event() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO public.outbox_event (org_id, type, payload)
  VALUES (NEW.org_id, 'import.finished', jsonb_build_object('importJobId', NEW.id));
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.import_finished_event() FROM PUBLIC;

CREATE TRIGGER import_job_finished
  AFTER UPDATE OF status ON import_job
  FOR EACH ROW
  WHEN (NEW.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')
        AND OLD.status NOT IN ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED',
                               'EXPIRED'))
  EXECUTE FUNCTION app.import_finished_event();
