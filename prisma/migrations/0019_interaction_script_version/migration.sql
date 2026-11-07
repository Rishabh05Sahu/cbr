-- Phase 3 slice 10 (FR-098; ADR-0014 amendment, owner decisions 2026-10-29): an interaction
-- records the published call-script version the person last had on screen in the lead-page
-- script drawer before saving it. Nothing is recorded when the drawer was not opened; opening a
-- script writes nothing on its own (no view log).
--
--   interaction.script_version_id   the exact call_script_version shown (never "the latest").
--                                   Published versions never change (FR-097, migration 0014),
--                                   so the row stays identifiable after newer versions are
--                                   published or the script is archived. NULL: none shown.
--
-- Same organisation: the composite foreign key. Published: app.script_version_is_published(),
-- a SECURITY DEFINER check, because a sales role can no longer read a version whose script was
-- archived after it was shown, yet that version was really shown and must still be recordable.
-- The function returns only a boolean for one (org, version) pair.
--
-- Earlier migrations are not changed; existing rows keep NULL.

ALTER TABLE interaction ADD COLUMN script_version_id UUID;
ALTER TABLE interaction ADD CONSTRAINT interaction_org_id_script_version_id_fkey
  FOREIGN KEY (org_id, script_version_id) REFERENCES call_script_version (org_id, id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Coaching analysis reads interactions per script version.
CREATE INDEX interaction_org_id_script_version_id_idx ON interaction (org_id, script_version_id)
  WHERE script_version_id IS NOT NULL;

-- The definer may see only published versions, and only the columns the check needs.
CREATE POLICY definer_published_check ON call_script_version FOR SELECT TO crm_definer
  USING (published_at IS NOT NULL);
GRANT SELECT (id, org_id, published_at) ON call_script_version TO crm_definer;

CREATE FUNCTION app.script_version_is_published(p_org_id uuid, p_version_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM public.call_script_version v
                    WHERE v.id = p_version_id AND v.org_id = p_org_id
                      AND v.published_at IS NOT NULL)
  $$;
ALTER FUNCTION app.script_version_is_published(uuid, uuid) OWNER TO crm_definer;
REVOKE ALL ON FUNCTION app.script_version_is_published(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.script_version_is_published(uuid, uuid) TO crm_app;

-- Only a published version of the interaction's own organisation can be recorded.
CREATE FUNCTION app.interaction_script_version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.script_version_id IS NOT NULL THEN
    IF NOT app.script_version_is_published(NEW.org_id, NEW.script_version_id) THEN
      RAISE EXCEPTION 'script version % is not a published version of this organisation',
        NEW.script_version_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.interaction_script_version_guard() FROM PUBLIC;
CREATE TRIGGER interaction_script_version_guard BEFORE INSERT ON interaction
  FOR EACH ROW EXECUTE FUNCTION app.interaction_script_version_guard();
