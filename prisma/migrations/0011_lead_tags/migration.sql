-- Phase 2 FR-063 "add tag" (OD-05 default: tags, no KPI impact): organisation-defined lead tags
-- and the lead <-> tag link. Owner/Admin define tags (org.settings.manage); bulk "add tag" adds a
-- link per selected lead (lead.bulk_update). Tags are labels only: no stage or report changes.
--
-- Same conventions as 0003/0005/0009: org-scoped composite foreign keys, RLS enabled and forced,
-- migrator maintenance, crm_app tenant isolation, and RESTRICTIVE insert policies stamping the
-- session user and the transaction time. crm_app may only read and insert (no UPDATE, no DELETE:
-- renaming, removing a tag from a lead and deleting tags are not part of this change).

CREATE TABLE "lead_tag" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_tag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lead_tag_link" (
    "org_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "added_by" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- One link per lead and tag: adding a tag twice is impossible, not just avoided.
    CONSTRAINT "lead_tag_link_pkey" PRIMARY KEY ("lead_id", "tag_id")
);

CREATE UNIQUE INDEX "lead_tag_org_id_id_key" ON "lead_tag"("org_id", "id");
CREATE INDEX "lead_tag_link_org_id_tag_id_idx" ON "lead_tag_link"("org_id", "tag_id");

ALTER TABLE "lead_tag" ADD CONSTRAINT "lead_tag_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lead_tag" ADD CONSTRAINT "lead_tag_org_id_created_by_fkey" FOREIGN KEY ("org_id", "created_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lead_tag_link" ADD CONSTRAINT "lead_tag_link_org_id_lead_id_fkey" FOREIGN KEY ("org_id", "lead_id") REFERENCES "lead"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lead_tag_link" ADD CONSTRAINT "lead_tag_link_org_id_tag_id_fkey" FOREIGN KEY ("org_id", "tag_id") REFERENCES "lead_tag"("org_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lead_tag_link" ADD CONSTRAINT "lead_tag_link_org_id_added_by_fkey" FOREIGN KEY ("org_id", "added_by") REFERENCES "organization_membership"("org_id", "user_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Names are stored trimmed with single inner spaces (the app normalizes); one name per org,
-- ignoring case; at most 200 tags per org is enforced by the app.
ALTER TABLE lead_tag
  ADD CONSTRAINT lead_tag_name CHECK (length(name) BETWEEN 1 AND 50 AND name = btrim(name));
CREATE UNIQUE INDEX lead_tag_org_name_uq ON lead_tag (org_id, lower(name));

-- RLS: ENABLE + FORCE, migrator maintenance, crm_app tenant isolation (same text as 0005).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_tag', 'lead_tag_link'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY maintenance ON %I FOR ALL TO crm_migrator USING (true) WITH CHECK (true)', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO crm_app '
      'USING (org_id = (SELECT app.current_org_id())) '
      'WITH CHECK (org_id = (SELECT app.current_org_id()))', t);
  END LOOP;
END $$;

-- RESTRICTIVE: they narrow tenant_isolation. Rows are written by the session user, now.
CREATE POLICY actor_is_session_user ON lead_tag AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (created_by = (SELECT app.current_user_id()) AND created_at = now());
CREATE POLICY actor_is_session_user ON lead_tag_link AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (added_by = (SELECT app.current_user_id()) AND added_at = now());

-- crm_app: read and insert only. Other roles get nothing.
GRANT SELECT, INSERT ON lead_tag, lead_tag_link TO crm_app;
