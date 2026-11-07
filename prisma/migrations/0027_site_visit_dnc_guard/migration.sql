-- Site visits on Do-Not-Contact leads (ADR-0022, owner decision 2026-10-30): until the G5 review
-- decides, a visit is not created on a Do-Not-Contact lead and an existing one is not rescheduled
-- (its time changed). History stays readable; confirming, cancelling and recording the outcome of
-- an existing visit stay possible. No override. The application refuses the same first; this is the
-- database backstop, as for Call tasks (0020). Runs as the session role under RLS. No existing
-- migration is rewritten.

CREATE FUNCTION app.site_visit_dnc_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.scheduled_for IS NOT DISTINCT FROM OLD.scheduled_for THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM public.lead l
    WHERE l.id = NEW.lead_id AND l.contact_status = 'DO_NOT_CONTACT';
  IF FOUND THEN
    RAISE EXCEPTION 'lead % is do-not-contact: no site visit can be scheduled or rescheduled', NEW.lead_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.site_visit_dnc_guard() FROM PUBLIC;
CREATE TRIGGER site_visit_dnc_guard BEFORE INSERT OR UPDATE OF scheduled_for ON site_visit
  FOR EACH ROW EXECUTE FUNCTION app.site_visit_dnc_guard();
