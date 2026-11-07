-- Phase 3 slice 5: call script authoring and publishing (FR-095, FR-096 targeting, FR-097;
-- domain-model §2.5; ADR-0011). The lead-page script drawer (FR-099/FR-057) and recording the
-- version shown with an outcome (FR-098) are not part of this change.
--
--   call_script          the script: name, status DRAFT | PUBLISHED | ARCHIVED, targeting
--                        (transaction types, property types, language codes, lead sources) and the
--                        live published version. Name and targeting are script metadata, not
--                        versioned (domain-model: targeting lives on CallScript).
--   call_script_version  numbered content versions (the five sections, sanitized HTML). A
--                        version is created as a draft, may be edited while it is a draft, and is
--                        immutable once published (FR-097). At most one draft per script;
--                        editing a published script creates the next draft version.
--
-- Same conventions as 0003/0011/0012: org-scoped composite foreign keys, RLS enabled and forced,
-- migrator maintenance, crm_app tenant isolation, RESTRICTIVE insert policies stamping the
-- session user and the transaction time, column-level UPDATE grants, no DELETE (archive keeps
-- the script and every version). In addition, the role matrix (user-personas-and-roles §4.2) is
-- enforced in the database: script.manage (Owner/Admin) for every write and for drafts and
-- archived scripts; script.read (Owner, Admin, Sales Manager, Sales Executive) for published
-- scripts only. HR and platform support sessions read nothing.

CREATE TABLE "call_script" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "transaction_types" TEXT[] NOT NULL DEFAULT '{}',
    "property_types" TEXT[] NOT NULL DEFAULT '{}',
    "languages" TEXT[] NOT NULL DEFAULT '{}',
    "source_ids" UUID[] NOT NULL DEFAULT '{}',
    "current_version_id" UUID,
    "archived_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_script_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "call_script_version" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_script_version_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "call_script_org_id_id_key" ON "call_script"("org_id", "id");
CREATE UNIQUE INDEX "call_script_version_org_id_id_key" ON "call_script_version"("org_id", "id");
CREATE UNIQUE INDEX "call_script_version_script_id_version_no_key" ON "call_script_version"("script_id", "version_no");
CREATE INDEX "call_script_org_id_status_idx" ON "call_script"("org_id", "status");
-- One name per org, ignoring case (the app normalizes spacing).
CREATE UNIQUE INDEX call_script_org_name_uq ON call_script (org_id, lower(name));
-- FR-097: at most one draft (unpublished) version per script.
CREATE UNIQUE INDEX call_script_version_one_draft_uq ON call_script_version (script_id)
  WHERE published_at IS NULL;

ALTER TABLE "call_script" ADD CONSTRAINT "call_script_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "call_script" ADD CONSTRAINT "call_script_org_id_created_by_fkey" FOREIGN KEY ("org_id", "created_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "call_script_version" ADD CONSTRAINT "call_script_version_org_id_script_id_fkey" FOREIGN KEY ("org_id", "script_id") REFERENCES "call_script"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "call_script_version" ADD CONSTRAINT "call_script_version_org_id_created_by_fkey" FOREIGN KEY ("org_id", "created_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "call_script_version" ADD CONSTRAINT "call_script_version_org_id_published_by_fkey" FOREIGN KEY ("org_id", "published_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "call_script" ADD CONSTRAINT "call_script_org_id_current_version_id_fkey" FOREIGN KEY ("org_id", "current_version_id") REFERENCES "call_script_version"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE call_script
  ADD CONSTRAINT call_script_name CHECK (length(name) BETWEEN 1 AND 100 AND name = btrim(name)),
  ADD CONSTRAINT call_script_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  -- DRAFT: never published. PUBLISHED: has a live version. ARCHIVED: archived_at set.
  ADD CONSTRAINT call_script_state CHECK (
    (status = 'DRAFT' AND current_version_id IS NULL AND archived_at IS NULL)
    OR (status = 'PUBLISHED' AND current_version_id IS NOT NULL AND archived_at IS NULL)
    OR (status = 'ARCHIVED' AND archived_at IS NOT NULL)),
  ADD CONSTRAINT call_script_transaction_types CHECK (transaction_types
    <@ ARRAY['BUY', 'RENT', 'LEASE_COMMERCIAL', 'SELL', 'LET_OUT']::text[]),
  ADD CONSTRAINT call_script_property_types CHECK (property_types
    <@ ARRAY['APARTMENT', 'VILLA', 'PLOT', 'ROW_HOUSE', 'OFFICE', 'SHOP', 'WAREHOUSE', 'OTHER']::text[]),
  -- Languages are two-letter lowercase codes, like lead.preferred_language (0003).
  ADD CONSTRAINT call_script_languages CHECK (cardinality(languages) <= 20
    AND array_to_string(languages, ',') ~ '^([a-z]{2}(,[a-z]{2})*)?$'),
  ADD CONSTRAINT call_script_sources_size CHECK (cardinality(source_ids) <= 50),
  ADD CONSTRAINT call_script_version_positive CHECK (version >= 1);

ALTER TABLE call_script_version
  ADD CONSTRAINT call_script_version_no CHECK (version_no >= 1),
  ADD CONSTRAINT call_script_version_content CHECK (jsonb_typeof(content) = 'object'
    AND pg_column_size(content) <= 65536),
  ADD CONSTRAINT call_script_version_published CHECK ((published_at IS NULL) = (published_by IS NULL)),
  ADD CONSTRAINT call_script_version_version CHECK (version >= 1);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- A new version is a draft of a live (not archived) script, numbered next in line.
CREATE FUNCTION app.call_script_version_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  st text;
  last_no int;
BEGIN
  IF NEW.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'a script version is created as a draft' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s.status INTO st FROM public.call_script s WHERE s.id = NEW.script_id FOR UPDATE;
  IF st IS NULL OR st = 'ARCHIVED' THEN
    RAISE EXCEPTION 'script % is archived or missing', NEW.script_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(v.version_no), 0) INTO last_no
    FROM public.call_script_version v WHERE v.script_id = NEW.script_id;
  IF NEW.version_no <> last_no + 1 THEN
    RAISE EXCEPTION 'script % next version is %', NEW.script_id, last_no + 1
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.call_script_version_insert_guard() FROM PUBLIC;
CREATE TRIGGER call_script_version_insert_guard BEFORE INSERT ON call_script_version
  FOR EACH ROW EXECUTE FUNCTION app.call_script_version_insert_guard();

-- FR-097: a published version never changes. A draft may be edited (content), or published
-- (published_at = now(), content unchanged in the same statement), while its script is live.
CREATE FUNCTION app.call_script_version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'script version % is published and immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM public.call_script s WHERE s.id = OLD.script_id AND s.status <> 'ARCHIVED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'script % is archived', OLD.script_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'script version % version must increase', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.published_at IS NOT NULL THEN
    IF NEW.published_at <> now() THEN
      RAISE EXCEPTION 'script version % publication time must be now', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.content IS DISTINCT FROM OLD.content THEN
      RAISE EXCEPTION 'script version % content cannot change while publishing', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.call_script_version_guard() FROM PUBLIC;
CREATE TRIGGER call_script_version_guard BEFORE UPDATE ON call_script_version
  FOR EACH ROW EXECUTE FUNCTION app.call_script_version_guard();

-- The script: archived is final; the live version is one of its own published versions; the
-- archive time is the transaction time; every change raises the version.
CREATE FUNCTION app.call_script_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF OLD.status = 'ARCHIVED' THEN
    RAISE EXCEPTION 'script % is archived and final', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'script % version must increase', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.current_version_id IS DISTINCT FROM OLD.current_version_id THEN
    PERFORM 1 FROM public.call_script_version v
      WHERE v.id = NEW.current_version_id AND v.script_id = NEW.id AND v.published_at IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'script % live version must be one of its published versions', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status = 'ARCHIVED' AND NEW.archived_at <> now() THEN
    RAISE EXCEPTION 'script % archive time must be now', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.call_script_guard() FROM PUBLIC;
CREATE TRIGGER call_script_guard BEFORE UPDATE ON call_script
  FOR EACH ROW EXECUTE FUNCTION app.call_script_guard();

-- ---------------------------------------------------------------------------
-- RLS and the role matrix (§4.2)
-- ---------------------------------------------------------------------------

-- The session member's role in the session org (NULL for platform staff and non-members).
-- SECURITY INVOKER: crm_app reads its own org's memberships under their tenant policy.
CREATE FUNCTION app.current_member_role() RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT m.role FROM public.organization_membership m
     WHERE m.org_id = app.current_org_id() AND m.user_id = app.current_user_id()
       AND m.status = 'ACTIVE'
  $$;
REVOKE ALL ON FUNCTION app.current_member_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_member_role() TO crm_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['call_script', 'call_script_version'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY maintenance ON %I FOR ALL TO crm_migrator USING (true) WITH CHECK (true)', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO crm_app '
      'USING (org_id = (SELECT app.current_org_id())) '
      'WITH CHECK (org_id = (SELECT app.current_org_id()))', t);
  END LOOP;
END $$;

-- Reading: managers (Owner/Admin) see everything; sales roles see published scripts only.
CREATE POLICY role_read ON call_script AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin')
    OR ((SELECT app.current_member_role()) IN ('sales_manager', 'sales_executive')
        AND status = 'PUBLISHED'));
CREATE POLICY role_read ON call_script_version AS RESTRICTIVE FOR SELECT TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin')
    OR ((SELECT app.current_member_role()) IN ('sales_manager', 'sales_executive')
        AND published_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.call_script s
                     WHERE s.id = script_id AND s.status = 'PUBLISHED')));

-- Writing: Owner/Admin only, as the session user, now.
CREATE POLICY manage_insert ON call_script AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin')
    AND created_by = (SELECT app.current_user_id()) AND created_at = now()
    AND status = 'DRAFT' AND current_version_id IS NULL AND version = 1);
CREATE POLICY manage_update ON call_script AS RESTRICTIVE FOR UPDATE TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin'))
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin'));
CREATE POLICY manage_insert ON call_script_version AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin')
    AND created_by = (SELECT app.current_user_id()) AND created_at = now() AND version = 1);
CREATE POLICY manage_update ON call_script_version AS RESTRICTIVE FOR UPDATE TO crm_app
  USING ((SELECT app.current_member_role()) IN ('owner', 'admin'))
  WITH CHECK ((SELECT app.current_member_role()) IN ('owner', 'admin')
    AND (published_by IS NULL OR published_by = (SELECT app.current_user_id())));

-- crm_app: read, insert, and update only the columns authoring needs. No DELETE.
GRANT SELECT, INSERT ON call_script, call_script_version TO crm_app;
GRANT UPDATE (name, status, transaction_types, property_types, languages, source_ids,
  current_version_id, archived_at, version, updated_at) ON call_script TO crm_app;
GRANT UPDATE (content, published_at, published_by, version, updated_at) ON call_script_version
  TO crm_app;
