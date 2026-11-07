-- Phase 5, FR-140 property inventory with FR-142 confidential owner contacts (ADR-0021).
-- Domain model §2.7: Property and PropertyContact ("restricted, separate table so field-level
-- permission is simple"; "Audit: every read via UI reveal + changes"). Role matrix §4.5:
--   property.read                O / O / O / O / —   (Owner, Admin, Sales Manager, Sales Exec; not HR)
--   property.manage              O / O / O (cfg) / own listings (cfg) / —
--   property.read_owner_contact  O / O / O / cfg (own listings) / —
-- "cfg" needs an org setting that does not exist, so (as for script.manage, ADR-0011) only Owner
-- and Admin manage, and Owner, Admin and Sales Manager read owner contacts.
--
-- Not here: projects (FR-145, OD-07 open) and RERA fields (OD-10 open), media (FR-141), matching
-- (FR-143), shares (FR-144), deals (FR-153), property-linked visits (FR-157).
-- Properties are never deleted: WITHDRAWN takes a listing off the market. No existing migration
-- is rewritten.

CREATE TABLE "property" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "listing_type" TEXT NOT NULL,
    "property_type" TEXT NOT NULL,
    "bhk" INTEGER,
    "city" TEXT NOT NULL,
    "locality" TEXT,
    "address_line" TEXT,
    "latitude" NUMERIC(9,6),
    "longitude" NUMERIC(9,6),
    "price" NUMERIC(15,2) NOT NULL,
    "price_type" TEXT NOT NULL,
    "maintenance" NUMERIC(15,2),
    "deposit" NUMERIC(15,2),
    "carpet_area_sqft" NUMERIC(10,2),
    "built_up_area_sqft" NUMERIC(10,2),
    "floor" TEXT,
    "facing" TEXT,
    "furnishing" TEXT,
    "amenities" TEXT[] NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "responsible_user_id" UUID NOT NULL,
    "available_from" DATE,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "property_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "property_org_id_id_key" ON "property"("org_id", "id");
CREATE UNIQUE INDEX "property_org_id_code_key" ON "property"("org_id", "code");
CREATE INDEX "property_org_id_status_city_property_type_price_idx" ON "property"("org_id", "status", "city", "property_type", "price");
CREATE INDEX "property_org_id_locality_idx" ON "property"("org_id", "locality");
ALTER TABLE "property" ADD CONSTRAINT "property_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "property" ADD CONSTRAINT "property_org_id_responsible_user_id_fkey" FOREIGN KEY ("org_id", "responsible_user_id") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "property" ADD CONSTRAINT "property_org_id_created_by_fkey" FOREIGN KEY ("org_id", "created_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE property
  ADD CONSTRAINT property_code CHECK (code ~ '^P-[0-9]{5,}$'),
  ADD CONSTRAINT property_title CHECK (length(title) BETWEEN 1 AND 200 AND title = btrim(title)),
  ADD CONSTRAINT property_listing_type CHECK (listing_type IN ('SALE', 'RENT', 'LEASE')),
  ADD CONSTRAINT property_property_type CHECK (property_type IN
    ('APARTMENT', 'VILLA', 'PLOT', 'ROW_HOUSE', 'OFFICE', 'SHOP', 'WAREHOUSE', 'OTHER')),
  ADD CONSTRAINT property_bhk CHECK (bhk IS NULL OR bhk BETWEEN 0 AND 20),
  ADD CONSTRAINT property_city CHECK (length(city) BETWEEN 1 AND 100 AND city = btrim(city)),
  ADD CONSTRAINT property_texts CHECK (
    (locality IS NULL OR length(locality) BETWEEN 1 AND 100)
    AND (address_line IS NULL OR length(address_line) BETWEEN 1 AND 300)
    AND (floor IS NULL OR length(floor) BETWEEN 1 AND 20)
    AND (description IS NULL OR length(description) BETWEEN 1 AND 5000)),
  ADD CONSTRAINT property_geo CHECK ((latitude IS NULL) = (longitude IS NULL)
    AND (latitude IS NULL OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180))),
  -- Sale prices are a total or per sq ft; rent and lease prices are monthly.
  ADD CONSTRAINT property_price CHECK (price > 0 AND (
    (listing_type = 'SALE' AND price_type IN ('TOTAL', 'PER_SQFT'))
    OR (listing_type IN ('RENT', 'LEASE') AND price_type = 'MONTHLY_RENT'))),
  ADD CONSTRAINT property_money CHECK ((maintenance IS NULL OR maintenance >= 0)
    AND (deposit IS NULL OR (deposit >= 0 AND listing_type IN ('RENT', 'LEASE')))),
  ADD CONSTRAINT property_area CHECK ((carpet_area_sqft IS NULL OR carpet_area_sqft > 0)
    AND (built_up_area_sqft IS NULL OR built_up_area_sqft > 0)),
  ADD CONSTRAINT property_facing CHECK (facing IS NULL OR facing IN ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW')),
  ADD CONSTRAINT property_furnishing CHECK (furnishing IS NULL OR furnishing IN ('UNFURNISHED', 'SEMI_FURNISHED', 'FURNISHED')),
  ADD CONSTRAINT property_amenities CHECK (cardinality(amenities) <= 30),
  -- Sold applies to sales; rented to rentals and leases.
  ADD CONSTRAINT property_status CHECK (
    status IN ('DRAFT', 'AVAILABLE', 'ON_HOLD', 'WITHDRAWN')
    OR (status = 'SOLD' AND listing_type = 'SALE')
    OR (status = 'RENTED' AND listing_type IN ('RENT', 'LEASE'))),
  ADD CONSTRAINT property_version CHECK (version >= 1);

-- The code never changes; every change raises the version.
CREATE FUNCTION app.property_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.code <> OLD.code OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'property % code and creation never change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'property % version must increase', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.property_guard() FROM PUBLIC;
CREATE TRIGGER property_guard BEFORE UPDATE ON property FOR EACH ROW EXECUTE FUNCTION app.property_guard();

-- Owner / agent / developer contacts of a property (FR-142), in their own table.
CREATE TABLE "property_contact" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone_e164" TEXT,
    "email" TEXT,
    "relationship" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by" UUID,

    CONSTRAINT "property_contact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "property_contact_org_id_id_key" ON "property_contact"("org_id", "id");
CREATE INDEX "property_contact_org_id_property_id_idx" ON "property_contact"("org_id", "property_id");
ALTER TABLE "property_contact" ADD CONSTRAINT "property_contact_org_id_property_id_fkey" FOREIGN KEY ("org_id", "property_id") REFERENCES "property"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "property_contact" ADD CONSTRAINT "property_contact_org_id_created_by_fkey" FOREIGN KEY ("org_id", "created_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "property_contact" ADD CONSTRAINT "property_contact_org_id_removed_by_fkey" FOREIGN KEY ("org_id", "removed_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE property_contact
  ADD CONSTRAINT property_contact_name CHECK (length(name) BETWEEN 1 AND 120 AND name = btrim(name)),
  ADD CONSTRAINT property_contact_phone CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+91[6-9][0-9]{9}$'),
  ADD CONSTRAINT property_contact_email CHECK (email IS NULL OR (length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  ADD CONSTRAINT property_contact_reachable CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL),
  ADD CONSTRAINT property_contact_relationship CHECK (relationship IN ('OWNER', 'AUTHORISED_AGENT', 'DEVELOPER')),
  ADD CONSTRAINT property_contact_removed CHECK ((removed_at IS NULL) = (removed_by IS NULL));

-- RLS: ENABLE + FORCE, migrator maintenance, crm_app tenant isolation, and RESTRICTIVE role
-- policies (as call scripts, 0014): the database enforces the matrix as well as the application.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['property', 'property_contact'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY maintenance ON %I FOR ALL TO crm_migrator USING (true) WITH CHECK (true)', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO crm_app '
      'USING (org_id = (SELECT app.current_org_id())) '
      'WITH CHECK (org_id = (SELECT app.current_org_id()))', t);
  END LOOP;
END $$;

CREATE POLICY role_read ON property AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager', 'sales_executive'));
CREATE POLICY role_insert ON property AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin')
    AND created_by = (SELECT app.current_user_id()) AND created_at = now() AND version = 1);
CREATE POLICY role_update ON property AS RESTRICTIVE FOR UPDATE TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin'))
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin'));

CREATE POLICY role_read ON property_contact AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin', 'sales_manager'));
CREATE POLICY role_insert ON property_contact AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin')
    AND created_by = (SELECT app.current_user_id()) AND created_at = now()
    AND removed_at IS NULL AND removed_by IS NULL);
CREATE POLICY role_update ON property_contact AS RESTRICTIVE FOR UPDATE TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin'))
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin')
    AND removed_by = (SELECT app.current_user_id()) AND removed_at = now());

GRANT SELECT, INSERT ON property TO crm_app;
GRANT UPDATE (title, listing_type, property_type, bhk, city, locality, address_line, latitude,
  longitude, price, price_type, maintenance, deposit, carpet_area_sqft, built_up_area_sqft, floor,
  facing, furnishing, amenities, status, responsible_user_id, available_from, description, version,
  updated_at) ON property TO crm_app;
GRANT SELECT, INSERT ON property_contact TO crm_app;
-- A contact is removed (recorded), never edited or deleted.
GRANT UPDATE (removed_at, removed_by) ON property_contact TO crm_app;
