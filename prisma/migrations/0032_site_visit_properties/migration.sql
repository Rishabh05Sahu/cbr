-- Properties to show on a site visit (owner request 2026-11-24; FR-157 basic). One row per property
-- on a visit; the list is edited while the visit is open (added or removed), and stays as the
-- record once the visit closes.
--
--   site_visit_property   the visit and the property must be in the same organisation (composite
--                         foreign keys); a property appears at most once per visit; at most 10 per
--                         visit (app.site_visit_property_limit, under a per-visit advisory lock).
--
-- Access follows site_visit: sales roles only (HR none), tenant isolation, the inserting member is
-- the session user at the transaction time. Lead scope and "visit still open" are applied by the
-- application (visits module), as for site_visit itself.

CREATE TABLE "site_visit_property" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "site_visit_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "site_visit_property_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "site_visit_property_org_id_id_key" ON "site_visit_property"("org_id", "id");
CREATE UNIQUE INDEX "site_visit_property_visit_property_key"
  ON "site_visit_property"("site_visit_id", "property_id");
CREATE INDEX "site_visit_property_org_id_property_id_idx"
  ON "site_visit_property"("org_id", "property_id");

ALTER TABLE "site_visit_property" ADD CONSTRAINT "site_visit_property_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "site_visit_property" ADD CONSTRAINT "site_visit_property_org_id_site_visit_id_fkey"
  FOREIGN KEY ("org_id", "site_visit_id") REFERENCES "site_visit"("org_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "site_visit_property" ADD CONSTRAINT "site_visit_property_org_id_property_id_fkey"
  FOREIGN KEY ("org_id", "property_id") REFERENCES "property"("org_id", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "site_visit_property" ADD CONSTRAINT "site_visit_property_org_id_added_by_fkey"
  FOREIGN KEY ("org_id", "added_by") REFERENCES "organization_membership"("org_id", "user_id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- At most 10 properties on one visit, counted under a per-visit advisory lock so concurrent adds
-- cannot pass it (as property_photo_limit in 0030).
CREATE FUNCTION app.site_visit_property_limit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('site_visit_property:' || NEW.site_visit_id::text, 0));
  IF (SELECT count(*) FROM site_visit_property
       WHERE org_id = NEW.org_id AND site_visit_id = NEW.site_visit_id) >= 10 THEN
    RAISE EXCEPTION 'visit % already lists 10 properties', NEW.site_visit_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.site_visit_property_limit() FROM PUBLIC;
CREATE TRIGGER site_visit_property_limit BEFORE INSERT ON site_visit_property
  FOR EACH ROW EXECUTE FUNCTION app.site_visit_property_limit();

-- RLS: ENABLE + FORCE, migrator maintenance, crm_app tenant isolation, RESTRICTIVE sales roles.
ALTER TABLE site_visit_property ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_visit_property FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON site_visit_property FOR ALL TO crm_migrator
  USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON site_visit_property FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
CREATE POLICY role_sales ON site_visit_property AS RESTRICTIVE FOR ALL TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive'))
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive'));
CREATE POLICY actor_is_session_user ON site_visit_property AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (added_by = (SELECT app.current_user_id()) AND added_at = now());
GRANT SELECT, INSERT, DELETE ON site_visit_property TO crm_app;
