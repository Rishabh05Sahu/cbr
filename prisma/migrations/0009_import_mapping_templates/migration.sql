-- Phase 2 FR-041: saved import mapping templates ("saved mapping templates per source";
-- domain-model ImportMappingTemplate: name, source_id, mapping jsonb). Owner/Admin (lead.import)
-- save a validated mapping under a name and apply it to a later file of the same format.
-- A template stores only field -> column-heading text; never column positions of a particular
-- file, never cell values, never file contents. Applying it to a new file matches headings again
-- and leaves missing or ambiguous ones unmapped (src/modules/imports/templates.ts).
--
-- Same conventions as 0005: org-scoped composite foreign keys, RLS enabled and forced, the
-- migrator maintenance policy, crm_app tenant isolation, and a RESTRICTIVE insert policy that
-- stamps the session user. Templates are configuration, not history: crm_app may delete them
-- (there is no update; a changed format is saved again under a new name).

CREATE TABLE "import_mapping_template" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "source_id" UUID,
    "mapping" JSONB NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_mapping_template_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "import_mapping_template_org_id_id_key" ON "import_mapping_template"("org_id", "id");

ALTER TABLE "import_mapping_template" ADD CONSTRAINT "import_mapping_template_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "import_mapping_template" ADD CONSTRAINT "import_mapping_template_org_id_created_by_fkey" FOREIGN KEY ("org_id", "created_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "import_mapping_template" ADD CONSTRAINT "import_mapping_template_org_id_source_id_fkey" FOREIGN KEY ("org_id", "source_id") REFERENCES "lead_source"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Names are stored trimmed with single inner spaces (the app normalizes); one name per org,
-- ignoring case. The mapping is a small object of field -> heading text.
ALTER TABLE import_mapping_template
  ADD CONSTRAINT import_mapping_template_name CHECK (length(name) BETWEEN 1 AND 100
                                                     AND name = btrim(name)),
  ADD CONSTRAINT import_mapping_template_mapping CHECK (jsonb_typeof(mapping) = 'object'
                                                        AND octet_length(mapping::text) <= 16384);
CREATE UNIQUE INDEX import_mapping_template_org_name_uq
  ON import_mapping_template (org_id, lower(name));

-- RLS: ENABLE + FORCE, migrator maintenance, crm_app tenant isolation (same text as 0005).
ALTER TABLE import_mapping_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_mapping_template FORCE ROW LEVEL SECURITY;
CREATE POLICY maintenance ON import_mapping_template FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY tenant_isolation ON import_mapping_template FOR ALL TO crm_app
  USING (org_id = (SELECT app.current_org_id()))
  WITH CHECK (org_id = (SELECT app.current_org_id()));
-- RESTRICTIVE: narrows tenant_isolation. A template is saved by the session user, now.
CREATE POLICY actor_is_session_user ON import_mapping_template AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (created_by = (SELECT app.current_user_id()) AND created_at = now());

-- crm_app: read, save, delete. No UPDATE. crm_auth, crm_platform, crm_cleanup and crm_definer
-- get nothing.
GRANT SELECT, INSERT, DELETE ON import_mapping_template TO crm_app;
