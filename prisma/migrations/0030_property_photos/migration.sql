-- FR-141 property photos (owner request 2026-11-19: upload photos when adding a property).
-- Photos only; documents (PDF) are not part of this migration. ADR-0026.
--
-- Images are prepared in the browser (re-drawn, so every EXIF/XMP block, including GPS location,
-- is dropped; resized; a thumbnail made the same way) and checked by the server's structural
-- validator before storage: JPEG or WebP only, no metadata blocks, size and pixel limits. The
-- server never decodes an image. Files live in the private storage bucket under
-- orgs/<org>/property-photos/<property>/<128 random bits>.<jpg|webp>; the app streams them after a
-- permission check (no public or signed URL reaches a browser).
--
-- Role matrix §4.5 (as property, 0025): read Owner, Admin, Sales Manager, Sales Executive;
-- add and remove Owner and Admin. At most 20 photos per property (FR-141), enforced here under a
-- per-property lock as well as in the application. A photo is removed (recorded), never deleted.
-- No existing migration is rewritten.

CREATE TABLE "property_photo" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "thumb_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "thumb_bytes" INTEGER NOT NULL,
    "uploaded_by" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by" UUID,

    CONSTRAINT "property_photo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "property_photo_org_id_id_key" ON "property_photo"("org_id", "id");
CREATE INDEX "property_photo_org_id_property_id_uploaded_at_idx" ON "property_photo"("org_id", "property_id", "uploaded_at");
CREATE UNIQUE INDEX "property_photo_storage_key_key" ON "property_photo"("storage_key");
CREATE UNIQUE INDEX "property_photo_thumb_key_key" ON "property_photo"("thumb_key");
ALTER TABLE "property_photo" ADD CONSTRAINT "property_photo_org_id_property_id_fkey" FOREIGN KEY ("org_id", "property_id") REFERENCES "property"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "property_photo" ADD CONSTRAINT "property_photo_org_id_uploaded_by_fkey" FOREIGN KEY ("org_id", "uploaded_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "property_photo" ADD CONSTRAINT "property_photo_org_id_removed_by_fkey" FOREIGN KEY ("org_id", "removed_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE property_photo
  -- Keys name this photo's own org and property (cleanup and serving rely on it).
  ADD CONSTRAINT property_photo_storage_key CHECK (storage_key ~ ('^orgs/' || org_id::text
    || '/property-photos/' || property_id::text || '/[0-9a-f]{32}\.(jpg|webp)$')),
  ADD CONSTRAINT property_photo_thumb_key CHECK (thumb_key ~ ('^orgs/' || org_id::text
    || '/property-photos/' || property_id::text || '/[0-9a-f]{32}\.(jpg|webp)$')
    AND thumb_key <> storage_key),
  ADD CONSTRAINT property_photo_content_type CHECK (content_type IN ('image/jpeg', 'image/webp')),
  ADD CONSTRAINT property_photo_size CHECK (width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096
    AND bytes BETWEEN 1 AND 10485760 AND thumb_bytes BETWEEN 1 AND 1048576),
  ADD CONSTRAINT property_photo_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL));

-- FR-141: at most 20 photos on a property. Concurrent uploads to one property queue on a
-- transaction-scoped lock, so the count cannot be raced.
CREATE FUNCTION app.property_photo_limit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('property_photo:' || NEW.property_id::text, 0));
  IF (SELECT count(*) FROM property_photo
       WHERE org_id = NEW.org_id AND property_id = NEW.property_id AND removed_at IS NULL) >= 20 THEN
    RAISE EXCEPTION 'property % already has 20 photos', NEW.property_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.property_photo_limit() FROM PUBLIC;
CREATE TRIGGER property_photo_limit BEFORE INSERT ON property_photo
  FOR EACH ROW EXECUTE FUNCTION app.property_photo_limit();

-- RLS: ENABLE + FORCE, migrator maintenance, crm_app tenant isolation, RESTRICTIVE role policies.
ALTER TABLE property_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_photo FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON property_photo FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON property_photo FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
CREATE POLICY role_read ON property_photo AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive'));
CREATE POLICY role_insert ON property_photo AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin')
    AND uploaded_by = (SELECT app.current_user_id()) AND uploaded_at = now()
    AND removed_at IS NULL AND removed_by IS NULL);
CREATE POLICY role_update ON property_photo AS RESTRICTIVE FOR UPDATE TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin'))
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin')
    AND removed_by = (SELECT app.current_user_id()) AND removed_at = now());

GRANT SELECT, INSERT ON property_photo TO crm_app;
-- A photo is removed (recorded), never edited or deleted.
GRANT UPDATE (removed_at, removed_by) ON property_photo TO crm_app;
