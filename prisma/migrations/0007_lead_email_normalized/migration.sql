-- Phase 2 M6 P-B: normalised e-mail for the M5 duplicate check. Hand-written.
-- PROPOSED, NOT PROMOTED: applied only to the throwaway crm_perf database
-- (scripts/perf/perf-db.mjs apply). Moving it into prisma/migrations needs owner approval.
--
-- Why: `lead.email` is citext, and citext equality is not LEAKPROOF, so under RLS no index can
-- serve `email = $1` and every created lead scanned the whole table (M6 load-test plan F-1, F-3).
-- This column holds lower(email::text), the value citext equality compares (citext lowercases
-- both sides with lower() under the column's collation). Equality on it is plain text equality
-- (texteq, LEAKPROOF), which RLS lets an index serve.
--
-- Maintained by the database on every write path (manual create, import, any later edit). No
-- application code writes it, and nobody can: a generated column rejects explicit values.
-- NULL e-mail gives NULL; '' gives ''.
--
-- No RLS, policy, role or grant change. The column inherits the lead table's policies. crm_app's
-- table-level SELECT covers it; its INSERT cannot set a generated column; its column-level
-- UPDATE grant (0003) does not list it.
--
-- Deliberately NOT unique: duplicates stay a review queue (M5, lead-lifecycle §5.1).
-- Lock and cost: ADD COLUMN ... STORED rewrites the table under ACCESS EXCLUSIVE. Measured on
-- crm_perf (255k leads); see docs/PHASE-2-M6-LOAD-TEST-PLAN.md §7.

ALTER TABLE lead
  ADD COLUMN email_normalized TEXT GENERATED ALWAYS AS (lower(email::text)) STORED;

-- Partial: only leads with an e-mail are ever looked up (detectEmailDuplicates skips blanks).
CREATE INDEX lead_org_id_email_normalized_idx ON lead (org_id, email_normalized)
  WHERE email_normalized IS NOT NULL;
