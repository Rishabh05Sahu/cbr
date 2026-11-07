# Recovery Test Results

> The owner requires the 4 h recovery objective and the 7-day recovery window to be **validated, not assumed**, and the effective RPO to be **measured and documented**.
> **Status (2026-10-20):** the procedures are validated **locally**. The managed-database measurements are pending staging (G4 in the [staging runbook](../runbooks/staging-preparation.md)).
> Local numbers come from a Windows laptop with Docker and are **not** a prediction for managed hosting.

## 1. Logical backup/restore (`pnpm drill:logical`)

Raw output: `scripts/recovery/results/logical-restore.json`.

| Item | Result |
|---|---|
| Dataset (synthetic) | 40 orgs, 2,400 users + credentials, 2,400 memberships, 160 teams, 400,000 audit rows, 50,000 outbox rows; database 138 MB |
| `pg_dump -Fc` | 1.6 s, 16 MB |
| `pg_restore -j 4` into a fresh database | 2.3 s |
| Data verification | 9 tables: row count + ordered-id checksum identical (0 mismatches) |
| Security layer after restore | 0 tables without forced RLS; 39 policies; 52 role grants; 5 definer functions still owned by `crm_definer` |
| Runtime role on the restored DB, no context | sees 0 memberships (fails closed) |
| **Result** | **PASS** |

## 2. Point-in-time recovery, WAL archiving method (`pnpm drill:pitr`)

Raw output: `scripts/recovery/results/pitr.json`. Method:
1. Primary with WAL archiving (`archive_timeout` 30 s) and a base backup.
2. A writer commits a timestamped row every 200 ms.
3. The primary is **SIGKILLed** and its data directory is treated as lost.
4. Recovery uses the base backup plus archived WAL.

| Item | Result |
|---|---|
| Last committed row before the crash | id 20279 at 07:42:20.431 |
| Last row after recovery to end of archive | id 20238 at 07:42:09.645 |
| **Measured RPO** | **10.8 s (41 committed rows lost)**. Bounded by `archive_timeout` (30 s): work in the current, un-archived WAL segment is lost when the primary's disk is lost |
| Recovery to end of archive (replay to available) | 2.2 s |
| Recovery to a chosen point in time | stopped exactly at the target (0 rows after it), 2.0 s |
| **Result** | **PASS**: the procedure works, and RPO is measurable |

## 3. What this means for the pilot

1. **PITR does not mean zero data loss.** It can lose the most recent committed transactions that were not yet archived. The "7 days" is how far back you can restore, not the loss window.
2. **The managed provider's real RPO is unknown until measured.** DigitalOcean's WAL archiving cadence is not published in the pages reviewed. The same writer-and-fork method (runbook §3) measures it on staging.
3. **Recovery time has two parts:**
   - the provider's fork/restore time, unknown and dependent on database size;
   - our repoint and redeploy steps.

   The 4 h objective is tested end to end on staging (runbook §3, step 7).
4. **Off-site nightly dumps** cover provider-account loss, with RPO ≤ 24 h. Restore from a dump is validated locally (§1).

## 4. Still to measure (before real customer data)

| Measurement | Where | Status |
|---|---|---|
| Effective RPO of managed PITR (worst of 3 runs) | Staging | Pending (needs approved spend) |
| Provider fork/restore duration | Staging | Pending |
| Full service RTO (≤ 4 h target) | Staging | Pending |
| Off-site dump restore from Spaces | Staging | Pending |
