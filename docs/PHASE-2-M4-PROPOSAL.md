# Phase 2 M4: approvals needed before the import flow is finished

> **Status:** A and B approved by the owner, 2026-10-23, with the worker importing as the uploader. §A is installed. §B is written as `prisma/migrations/0005_imports` with the changes listed in [PHASE-2-M4-REPORT.md](PHASE-2-M4-REPORT.md) ("0005 security review"), and is applied to local `crm_test` only (2026-10-23); not to `crm_dev` or any managed database. The flow built on it is described in the report.
>
> **Already done without these approvals:** storage gateway, file checks, column mapping, row validation, and the import write path on existing tables. See [PHASE-2-M4-REPORT.md](PHASE-2-M4-REPORT.md).

There are two decisions: **A** (parser packages) and **B** (migration `0005_imports`). Approve, change or reject each one separately.

## A. Spreadsheet parser

Recommendation: **`read-excel-file@9.3.12`** for XLSX, plus **`csv-parse@7.0.3`** for CSV. Both use exact pins and both pass the 7-day package-age rule (published 2026-10-07 and 2026-09-25). Parsing runs only in the worker, after the byte checks in `src/modules/imports/file-check.ts` have passed.

| | read-excel-file 9.3.12 + csv-parse 7.0.3 (**recommended**) | SheetJS `xlsx` 0.18.5 (npm) | exceljs 4.4.0 |
|---|---|---|---|
| Maintenance | Both actively released (Oct / Sep 2026) | Last npm release in 2022; newer builds are published only on the vendor's own CDN | Last stable release Oct 2023; only a 2024 prerelease since |
| Security | No known advisories found on the registry. Note: single maintainer, who also maintains its zip fork (`unzipper-esm`) | **Known advisories not fixed on npm**: prototype pollution (CVE-2023-30533) and ReDoS (CVE-2024-22363). The fixed builds sit outside the registry and outside our pnpm supply-chain policy | Old dependency tree (`unzipper` 0.10, `archiver` 5, `uuid` 8, `tmp`) |
| Licence | MIT / MIT | Apache-2.0 | MIT |
| TypeScript | Types bundled in both | Bundled | Bundled |
| Memory | CSV streams with a row cap. XLSX loads one sheet into memory, bounded by our own checks: ≤ 20 MB file, ≤ 256 MB verified uncompressed size, ≤ 100k rows × 100 columns | Whole workbook in memory | Has a streaming reader |
| Formulas / macros | Reads the saved cell values; never evaluates. Macro files are refused before parsing | Can parse formulas (we would not use them) | Reads formulas and their results |
| Dates and types | XLSX cells come back as string / number / boolean / Date. CSV is text only | Rich | Rich |
| CSV edge cases | csv-parse handles quoted newlines, BOM, a `to` row limit and `max_record_size` | Basic | Uses fast-csv |
| Dependencies added | read-excel-file: `fflate`, `saxen`, `unzipper-esm`, `worker-f` (plus `graceful-fs`, `node-int64`). csv-parse: none | none | about 10 |

**Why this pair:** neither single-package option is acceptable. SheetJS on npm carries unfixed advisories, and exceljs is unmaintained. With the pair, each format gets a small, maintained, MIT-licensed reader. Our own ZIP and encoding checks cover the risks the readers do not (zip bombs, macros, encryption).

**What approval covers:** `pnpm add --save-exact read-excel-file@9.3.12 csv-parse@7.0.3`, then a short spike test before any wiring. The spike confirms, on synthetic files: saved values are returned rather than formulas; date cells come back as dates; sheet names can be listed and chosen; a 100k-row file finishes within the 120 s parse budget; and `pnpm audit` is clean.

## B. Migration `0005_imports`: schema, tenant isolation, RLS and grants

### B.1 What it adds (the minimum)

| Object | Why it cannot simply be derived |
|---|---|
| `import_job` | Import history (FR-050), status that survives a page refresh, the resume cursor (FR-048), counters (FR-046), the storage key and file-cleanup times, the content hash (FR-049) and the uploader's attestation (FR-170) |
| `import_row_result` | Per-row problems and duplicate matches (FR-042, FR-045, FR-047): row number, field, code, and the matched lead id. **No cell values.** |
| `app.import_files_due(int)` | One cross-org, column-limited lookup of expired files for the cleanup sweep. Same pattern as `app.outbox_claim` |
| `import_job_guard` trigger | Finished, cancelled and expired jobs cannot be restarted, and status changes follow the allowed transitions |

Nothing else changes:
- No change to existing tables, policies, grants or roles.
- Lead rows reuse `lead_enquiry.external_id` (`"<importId>:<row>"`) and `channel_ref = 'IMPORT'` for idempotency. That unique index already exists (0003).
- Assignment and stage history already accept source `IMPORT` (0003/0004).
- Saved mapping templates (FR-041) are **deferred**. Auto-suggest by header name works without them.
- Rejected-rows downloads (FR-047) are built on request from the stored file while it still exists (24 h), so raw rows are never copied into the database.

### B.2 Proposed SQL

The Prisma models would be generated the usual way (`prisma migrate diff`). The hand-written part below the marker is the security-relevant content:

```sql
-- ===========================================================================
-- Generated part (shown as DDL for review)
-- ===========================================================================
CREATE TABLE import_job (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id               uuid NOT NULL,
  created_by           uuid NOT NULL,
  status               text NOT NULL DEFAULT 'AWAITING_UPLOAD',
  file_type            text NOT NULL,
  content_type         text NOT NULL,
  original_filename    text NOT NULL,          -- display only, never a storage key
  byte_size            bigint NOT NULL,        -- declared at grant time, verified after upload
  storage_key          text NOT NULL,
  sha256               bytea,                  -- set by the worker after inspection (FR-049)
  sheet_names          text[] NOT NULL DEFAULT '{}',
  sheet_name           text,
  headers              text[] NOT NULL DEFAULT '{}',   -- column names only, for the mapping screen
  mapping              jsonb,                  -- { field: columnIndex }
  default_source_id    uuid,
  duplicate_policy     text NOT NULL DEFAULT 'ATTACH',
  assignment           jsonb NOT NULL DEFAULT '{"mode":"none"}',
  dry_run              boolean NOT NULL DEFAULT false,
  attested_at          timestamptz,            -- uploader attestation of lawful source (FR-170)
  attestation_version  text,
  hash_warning_ack_at  timestamptz,
  duplicate_of_job_id  uuid,
  validation_attempt   integer NOT NULL DEFAULT 0,
  next_row             integer NOT NULL DEFAULT 0,      -- resume cursor (data rows committed)
  rows_total           integer NOT NULL DEFAULT 0,
  rows_empty           integer NOT NULL DEFAULT 0,
  rows_valid           integer NOT NULL DEFAULT 0,
  rows_invalid         integer NOT NULL DEFAULT 0,
  rows_duplicate_in_file integer NOT NULL DEFAULT 0,
  rows_created         integer NOT NULL DEFAULT 0,
  rows_attached        integer NOT NULL DEFAULT 0,
  rows_skipped         integer NOT NULL DEFAULT 0,
  rows_failed          integer NOT NULL DEFAULT 0,
  error_code           text,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  upload_expires_at    timestamptz NOT NULL,
  uploaded_at          timestamptz,
  validated_at         timestamptz,
  started_at           timestamptz,
  finished_at          timestamptz,
  cancel_requested_at  timestamptz,
  purge_file_after     timestamptz NOT NULL,   -- created_at + 3 h until terminal, then finished_at + 24 h
  file_deleted_at      timestamptz
);
CREATE UNIQUE INDEX import_job_org_id_id_key ON import_job (org_id, id);
CREATE UNIQUE INDEX import_job_storage_key_key ON import_job (storage_key);
CREATE INDEX import_job_org_id_created_at_id_idx ON import_job (org_id, created_at DESC, id);
ALTER TABLE import_job
  ADD CONSTRAINT import_job_org_id_fkey FOREIGN KEY (org_id) REFERENCES organization (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT import_job_org_id_created_by_fkey FOREIGN KEY (org_id, created_by)
    REFERENCES organization_membership (org_id, user_id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT import_job_org_id_default_source_id_fkey FOREIGN KEY (org_id, default_source_id)
    REFERENCES lead_source (org_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT import_job_org_id_duplicate_of_job_id_fkey FOREIGN KEY (org_id, duplicate_of_job_id)
    REFERENCES import_job (org_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE import_row_result (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         uuid NOT NULL,
  import_job_id  uuid NOT NULL,
  phase          text NOT NULL,      -- VALIDATE | IMPORT
  attempt        integer NOT NULL,   -- import_job.validation_attempt it belongs to
  row_number     integer NOT NULL,
  outcome        text NOT NULL,
  field          text,
  code           text NOT NULL,
  related_row    integer,            -- in-file duplicate: the first row
  lead_id        uuid,               -- existing-lead duplicate: the matched lead
  created_at     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX import_row_result_org_id_id_key ON import_row_result (org_id, id);
ALTER TABLE import_row_result
  ADD CONSTRAINT import_row_result_org_id_import_job_id_fkey FOREIGN KEY (org_id, import_job_id)
    REFERENCES import_job (org_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT import_row_result_org_id_lead_id_fkey FOREIGN KEY (org_id, lead_id)
    REFERENCES lead (org_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===========================================================================
-- Hand-written part (security). Runs as crm_migrator. New tables only.
-- ===========================================================================

-- 1. Integrity
ALTER TABLE import_job
  ADD CONSTRAINT import_job_status CHECK (status IN ('AWAITING_UPLOAD', 'UPLOADED', 'ANALYSING',
    'NEEDS_MAPPING', 'VALIDATING', 'READY', 'IMPORTING', 'COMPLETED', 'COMPLETED_WITH_ERRORS',
    'FAILED', 'CANCELLED', 'EXPIRED')),
  ADD CONSTRAINT import_job_file_type CHECK (file_type IN ('csv', 'xlsx')),
  ADD CONSTRAINT import_job_content_type CHECK (content_type IN ('text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  ADD CONSTRAINT import_job_byte_size CHECK (byte_size BETWEEN 1 AND 52428800),
  ADD CONSTRAINT import_job_filename CHECK (length(original_filename) BETWEEN 1 AND 200
    AND original_filename !~ '[/\\[:cntrl:]]'),
  -- The key is namespaced by this row's org and id; the database refuses anything else.
  ADD CONSTRAINT import_job_storage_key CHECK (storage_key ~ ('^orgs/' || org_id::text ||
    '/imports/' || id::text || '/[0-9a-f]{32}\.(csv|xlsx)$')),
  ADD CONSTRAINT import_job_sha256 CHECK (sha256 IS NULL OR length(sha256) = 32),
  ADD CONSTRAINT import_job_lists CHECK (cardinality(sheet_names) <= 20 AND cardinality(headers) <= 100),
  ADD CONSTRAINT import_job_mapping CHECK (mapping IS NULL OR jsonb_typeof(mapping) = 'object'),
  ADD CONSTRAINT import_job_assignment CHECK (jsonb_typeof(assignment) = 'object'
    AND assignment->>'mode' IN ('none', 'target', 'round_robin')),
  ADD CONSTRAINT import_job_duplicate_policy CHECK (duplicate_policy IN ('ATTACH', 'SKIP')),
  ADD CONSTRAINT import_job_counters CHECK (least(rows_total, rows_empty, rows_valid, rows_invalid,
    rows_duplicate_in_file, rows_created, rows_attached, rows_skipped, rows_failed, next_row,
    validation_attempt) >= 0 AND rows_total <= 100000),
  -- Leads are only written for an attested, non-dry-run import.
  ADD CONSTRAINT import_job_attested CHECK (status NOT IN ('IMPORTING', 'COMPLETED',
    'COMPLETED_WITH_ERRORS') OR (attested_at IS NOT NULL AND NOT dry_run)),
  ADD CONSTRAINT import_job_terminal_finished CHECK (status NOT IN ('COMPLETED',
    'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED', 'EXPIRED') OR finished_at IS NOT NULL),
  ADD CONSTRAINT import_job_error_code CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,50}$');
-- Threat model: one running import per org.
CREATE UNIQUE INDEX import_job_one_running_uq ON import_job (org_id) WHERE status = 'IMPORTING';
CREATE INDEX import_job_hash_idx ON import_job (org_id, sha256, created_at) WHERE sha256 IS NOT NULL;
CREATE INDEX import_job_purge_idx ON import_job (purge_file_after) WHERE file_deleted_at IS NULL;

ALTER TABLE import_row_result
  ADD CONSTRAINT import_row_result_phase CHECK (phase IN ('VALIDATE', 'IMPORT')),
  ADD CONSTRAINT import_row_result_outcome CHECK (outcome IN ('INVALID', 'DUPLICATE_IN_FILE',
    'DUPLICATE_ATTACHED', 'DUPLICATE_SKIPPED', 'FAILED')),
  ADD CONSTRAINT import_row_result_codes CHECK (code ~ '^[A-Z0-9_]{1,50}$'
    AND (field IS NULL OR field ~ '^[A-Za-z_]{1,50}$')),
  ADD CONSTRAINT import_row_result_row CHECK (row_number BETWEEN 1 AND 1000001);
-- A retried batch or validation pass never duplicates a result.
CREATE UNIQUE INDEX import_row_result_uq ON import_row_result
  (import_job_id, phase, attempt, row_number, outcome, coalesce(field, ''), code);

-- State machine: terminal jobs are frozen; only the listed transitions are allowed.
CREATE FUNCTION app.import_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED', 'EXPIRED')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'import job % is finished', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status, NEW.status) IN (
      ('AWAITING_UPLOAD', 'UPLOADED'), ('UPLOADED', 'ANALYSING'), ('ANALYSING', 'NEEDS_MAPPING'),
      ('NEEDS_MAPPING', 'VALIDATING'), ('VALIDATING', 'READY'), ('READY', 'VALIDATING'),
      ('READY', 'IMPORTING'), ('IMPORTING', 'COMPLETED'), ('IMPORTING', 'COMPLETED_WITH_ERRORS'),
      ('READY', 'COMPLETED'),                      -- dry run finished
      ('AWAITING_UPLOAD', 'EXPIRED'), ('UPLOADED', 'EXPIRED'), ('NEEDS_MAPPING', 'EXPIRED'),
      ('READY', 'EXPIRED'))
     AND NEW.status NOT IN ('FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'import job % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_job_guard BEFORE UPDATE ON import_job
  FOR EACH ROW EXECUTE FUNCTION app.import_job_guard();

-- 2. RLS: ENABLE + FORCE, maintenance, tenant isolation (same text as 0002–0004)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_job', 'import_row_result'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY maintenance ON %I FOR ALL TO crm_migrator USING (true) WITH CHECK (true)', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL TO crm_app '
      'USING (org_id = (SELECT app.current_org_id())) '
      'WITH CHECK (org_id = (SELECT app.current_org_id()))', t);
  END LOOP;
END $$;

-- RESTRICTIVE: narrow tenant_isolation, never widen it.
-- A job is created by the session user, at the transaction time, in its first state.
CREATE POLICY actor_is_session_user ON import_job AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (created_by = (SELECT app.current_user_id()) AND status = 'AWAITING_UPLOAD'
              AND created_at = now() AND file_deleted_at IS NULL);
-- Results are written only while their job is validating or importing.
CREATE POLICY job_is_active ON import_row_result AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (EXISTS (SELECT 1 FROM import_job j WHERE j.id = import_job_id
                      AND j.org_id = import_row_result.org_id
                      AND j.status IN ('VALIDATING', 'IMPORTING')));

-- 3. Grants (minimum). No DELETE. crm_auth / crm_platform get nothing.
GRANT SELECT, INSERT ON import_job, import_row_result TO crm_app;
-- Identity, tenant, uploader, storage key, file type/size/name and created_at are never updatable.
GRANT UPDATE (status, sha256, sheet_names, sheet_name, headers, mapping, default_source_id,
  duplicate_policy, assignment, dry_run, attested_at, attestation_version, hash_warning_ack_at,
  duplicate_of_job_id, validation_attempt, next_row, rows_total, rows_empty, rows_valid,
  rows_invalid, rows_duplicate_in_file, rows_created, rows_attached, rows_skipped, rows_failed,
  error_code, version, updated_at, uploaded_at, validated_at, started_at, finished_at,
  cancel_requested_at, purge_file_after, file_deleted_at) ON import_job TO crm_app;
REVOKE ALL ON FUNCTION app.import_job_guard() FROM PUBLIC;

-- 4. Cleanup lookup across orgs (definer, column-limited, ids and keys only, no PII)
CREATE POLICY definer_lookup ON import_job FOR SELECT TO crm_definer USING (true);
GRANT SELECT (id, org_id, storage_key, purge_file_after, file_deleted_at) ON import_job TO crm_definer;
CREATE FUNCTION app.import_files_due(max_rows int)
  RETURNS TABLE (org_id uuid, import_job_id uuid, storage_key text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
    SELECT j.org_id, j.id, j.storage_key FROM public.import_job j
    WHERE j.file_deleted_at IS NULL AND j.purge_file_after <= now()
    ORDER BY j.purge_file_after LIMIT least(greatest(max_rows, 0), 500)
  $$;
ALTER FUNCTION app.import_files_due(int) OWNER TO crm_definer;
REVOKE ALL ON FUNCTION app.import_files_due(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_files_due(int) TO crm_app;
```

### B.3 Answers to the seven questions

1. **Organisation-scoped keys and integrity.**
   - Every FK is composite: `(org_id, …)` to membership, source, job and lead. A row cannot point into another org.
   - The CHECK on `storage_key` ties the object path to the row's own `org_id` and `id`.
   - Status, policy, counters and codes are all CHECKed.
   - At most one import runs per org (partial unique index).
2. **RLS.** Both tables have RLS enabled and forced, plus `maintenance` and `tenant_isolation`, with the same text as every earlier tenant table. The automated catalog check in `db-roles.test.ts` will cover them.
3. **Restrictive policies.**
   - `actor_is_session_user` on `import_job` INSERT: the uploader is the session user, the row is stamped with the database time, and it starts in the first state.
   - `job_is_active` on `import_row_result` INSERT: results can only be added while their job is validating or importing.
   - The guard trigger stops finished jobs from being reused.
   - No existing policy is changed.
4. **Privileges.**

   | Role | `import_job` | `import_row_result` | Notes |
   |---|---|---|---|
   | `crm_app` | SELECT, INSERT; UPDATE on the listed columns only | SELECT, INSERT | No DELETE on either table |
   | `crm_definer` | SELECT on 5 columns, used only inside `app.import_files_due` | — | |
   | `crm_auth`, `crm_platform` | nothing | nothing | |

5. **Who can do what.** The new permission `lead.import` is already in the code catalog (Owner/Admin: org scope).
   - **Owners and Admins:** create, map, validate, confirm, cancel and view every import in their org.
   - **Sales Managers:** nothing. Their access is "cfg" in the roles matrix, off until an org setting exists.
   - **Executives, HR and support access:** nothing.
6. **Worker access, with no cross-tenant bypass.**
   - The worker receives `{orgId, importJobId}` through the existing transactional outbox.
   - Before every batch it opens `withTenant({ orgId, userId: <uploader> })` as `crm_app`. It first rebuilds the uploader's context from `app.auth_memberships_for_user`, the same function the web uses, and stops the import if the uploader is no longer an ACTIVE Owner/Admin of that org.
   - Leads are therefore attributed to the person who confirmed the import, and every existing actor policy applies unchanged.
   - The only cross-org access is `app.import_files_due`, which returns ids and storage keys. The worker then deletes an object only if `keyBelongsTo(key, orgId, 'imports', jobId)` holds, and marks the row inside that org's tenant transaction.
   - **Decision for you:** whether the worker should act as the uploader (proposed) or as a system actor (leads would get `created_by = NULL`).
7. **Rollback and cleanup.** The migration is purely additive.
   - Before any real data exists, a reviewed down script would: drop the function, trigger, policies and both tables, and revoke the `crm_definer` column grant.
   - Before dropping, run the storage sweep in the runbook so no files are left in the bucket.
   - Leads already created by imports are ordinary leads and are not removed.
   - Retention:
     - source files are deleted by the worker 24 h after a terminal status;
     - abandoned uploads are deleted after 3 h (after the 2-hour upload token has expired);
     - job history and row results are kept, because there is no DELETE grant. A purge policy for them would be a later, separately reviewed change.

### B.4 Two optional items (not included above)

- `import_mapping_template` (saved mappings per source, FR-041): recommended to be deferred.
- Widen the `notification_type` CHECK to add `IMPORT_FINISHED`, so the uploader gets an in-app notice. Without it, the import page shows the status, which survives a refresh.

## C. What happens after approval

- Install the parser pair and run the spike test.
- Write the `0005_imports` migration from B.2 and apply it **only to local `crm_test`/`crm_dev`**.
- Build the rest of the flow:
  - create a job and issue the upload grant;
  - verify the upload (stat, size, type);
  - worker: inspect, hash and parse; header mapping with suggestions;
  - validation pass (dry run), with in-file and existing duplicates;
  - attestation and confirm;
  - batched commit through `importLeadBatch`, with resume from `next_row`;
  - cancel, status polling, results, rejected-rows CSV, and the cleanup sweep.
- Tests: RLS catalog coverage for the new tables, cross-org and role isolation, forged ids, reuse of finished jobs, retry after a simulated worker crash, and cleanup ownership checks.
