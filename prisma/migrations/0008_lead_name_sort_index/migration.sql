-- Phase 2 M6 P-D: index for the lead list's "Name (A–Z)" sort and its keyset pagination.
-- PROPOSED, NOT PROMOTED: applied only to the throwaway crm_perf database
-- (scripts/perf/perf-db.mjs apply). Moving it into prisma/migrations needs owner approval.
--
-- Index only: no query, ordering, column, policy or grant change. searchLeads orders by
-- full_name ASC, id ASC under the column's default collation (ORDER in src/modules/leads/index.ts).
-- This index has the same columns, direction and collation, so the planner can read pages in
-- index order instead of sorting the org's leads. full_name and id are NOT NULL, so NULL
-- placement never applies. id stays the unique tie-breaker.
--
-- Write overhead and size are measured on crm_perf; see docs/PHASE-2-M6-LOAD-TEST-PLAN.md §7.
-- On a populated production table, build it with CREATE INDEX CONCURRENTLY in its own
-- non-transactional step instead.

CREATE INDEX lead_org_id_full_name_id_idx ON lead (org_id, full_name, id);
