# Proposed migrations

Nothing is pending here.

`0007_lead_email_normalized` (P-B) and `0008_lead_name_sort_index` (P-D) were reviewed here and applied only to the throwaway `crm_perf` database first.

On **2026-10-26**, with owner approval, they were promoted **unchanged** (byte-identical; SHA-256 `4f26dbdc82a7c581…` and `d241074bcf2db178…`) to `prisma/migrations/`. They were then applied to the local `crm_test` (after 0006) and `crm_dev` (0006, 0007, 0008 in order), after verified backups. The details are in [docs/PHASE-2-M6-LOAD-TEST-PLAN.md](../../docs/PHASE-2-M6-LOAD-TEST-PLAN.md) §8.1.

**Managed databases** (staging, production) get them only with the staging plan:

- 0007 rewrites the `lead` table under ACCESS EXCLUSIVE;
- 0008 should use `CREATE INDEX CONCURRENTLY`.

`node scripts/perf/perf-db.mjs apply <name>` still applies a future proposal from this folder to `crm_perf` only.
