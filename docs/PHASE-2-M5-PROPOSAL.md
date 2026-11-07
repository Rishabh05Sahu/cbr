# Phase 2 M5 (hygiene): plan, database change and results

> **M5: SIGNED OFF for the approved scope (owner, 2026-10-26).** See §L. This is the sign-off of the M5 milestone only. It is **not** Phase 2 release acceptance, and it does not sign off M4 (P6 open), Phase 1 P2 or M6. Statements below that M5 was "not signed off" are the history before this decision.
>
> **Status:** revision 3, 2026-10-24.
> - The owner approved design decisions D1–D5 (§C) and applying 0006 to **local `crm_test` only**, with amendment A1 (§B.2a).
> - **Applied:** `prisma/migrations/0006_hygiene/migration.sql` was applied to `crm_test` (local Docker, 127.0.0.1:55432) as `crm_migrator`. `schema.prisma` and the Prisma client are updated.
> - **Not applied:** `crm_dev` (verified read-only: still 0001–0005, no `export_job`) and every managed database.
> - **Results:** §G. It separates guarantees proven by database tests from protections that exist only in application code.

**Scope.** [PHASE-2-PLAN.md](PHASE-2-PLAN.md) M5 covers:
- FR-061 archive/restore (Must);
- FR-062 merge (Should);
- FR-063 bulk actions beyond assign (Should);
- FR-064 custom fields, at most 30 (Should);
- FR-066 export job (Should);
- the duplicate review queue.

**Why a migration is unavoidable.** `crm_app` cannot update `lead.archived_at` or `lead.merged_into_lead_id`. Custom fields, review cases and export jobs need new storage.

## A. Application code (local, uncommitted)

| Piece | What | Tests |
|---|---|---|
| Permissions | `lead.archive`, `lead.bulk_update`: Owner/Admin org-wide.<br>`lead.merge`: Owner/Admin org-wide, Sales Manager team.<br>`lead.delete` and `lead.export`: Owner only.<br>Support access gets none of these | `permissions.test.ts` 122/122 |
| `custom-fields.ts` (D5) | Definition schema and the ≤ 30-active rule. Values: unknown and archived keys refused, no coercion, real ISO dates, select membership, 16 KB cap | 22/22 |
| `merge-plan.ts` (D1) | Fill/conflict plan; refused until every conflict is resolved.<br>Rev. 2: refuses an **archived survivor** (`SURVIVOR_ARCHIVED`, mirrors the database).<br>Rev. 2: `resolveSurvivor` (follows merge pointers) and `timelineLeadIds` (the leads whose history forms the survivor's combined timeline). Both are depth-capped and detect cycles | 12/12 |
| `duplicate-review.ts` (D2, new) | Allowed decisions per case type and the permission each needs:<br>• pair cases: merge or dismiss (`lead.merge`);<br>• archived cases: restore or keep archived (`lead.archive`).<br>A case is resolved once. `routeMatchedEnquiry`: an enquiry is attached, **never restores**, and opens one archived case | 5/5 |
| `export-format.ts` (D3) | Watermarked CSV, formula escaping, 50,000-row cap (refuses, never truncates) | 11/11 |
| `export-job.ts` (D3, new) | 15-minute window clamped to the purge time, purge 1 h after creation, availability per state, 5 a day, 20 MB file cap (the bucket limit; refuse, never truncate).<br>Stored filters: the list's validated filters, ≤ 4 KB. **The audit copy records only that a search was used, never its text** | 4/4 |
| `storage/keys.ts` | New `exports` kind, CSV only, under the distinct `orgs/<org>/exports/<job>/` path in the same private bucket. An export key never matches an import record | 8/8 |
| `export-job.ts` (rev. 3) | `withoutSearch` (filters for a terminal state) and `assertExportSize`: a file over 20 MB fails with `EXPORT_FILE_TOO_LARGE`, never truncated. The 20 MB app and bucket limits are unchanged | 6/6 in total |
| `access.ts` `canonicalLeadId` (rev. 3) | `addNote` and `attachEnquiry` write to the surviving lead when given a merged lead's id. **Application-level only** (see §G.3) | `merge-redirect` 6/6 |

## B. Database change: `0006_hygiene` (applied to local `crm_test` only)

### B.1 Contents

| Change | Security notes |
|---|---|
| `lead.custom_fields jsonb` + CHECK (object, ≤ 16 KB) | Values are validated in code (§A) |
| `GRANT UPDATE (archived_at, merged_into_lead_id, custom_fields) ON lead TO crm_app` | **`deleted_at` stays ungranted (D4).** No other lead grant changes |
| Trigger `app.lead_hygiene_guard` | • Merged or deleted leads are frozen.<br>• `archived_at` can only be set to the transaction time, or cleared.<br>• The merge target must be live, unmerged, unarchived and in the same org, and is locked `FOR UPDATE` |
| `lead_activity_type` + `ARCHIVED`, `RESTORED`, `MERGED` | Same pattern as 0004 |
| Table `custom_field_definition` | • RLS enabled and forced; tenant isolation.<br>• RESTRICTIVE insert policy: the creator is the session user, at the transaction time.<br>• Key and type are never updatable; keys are never reused.<br>• Options must be 1–100-character strings.<br>• `app.custom_field_limit`: ≤ 30 active per org, under a per-org advisory lock |
| Table `lead_duplicate_match` | • RLS enabled and forced.<br>• Pair cases (two live leads) and `ARCHIVED_ENQUIRY` cases (an archived lead plus its enquiry; D2).<br>• Inserted only as OPEN, at the transaction time, by the session user.<br>• Resolved once, by the session user, at the transaction time.<br>• `app.duplicate_match_guard` checks that the recorded outcome is true.<br>• Unique per unordered pair, per enquiry, and one open archived case per lead |
| Table `export_job` | • RLS enabled and forced.<br>• `requester_only` for all commands.<br>• **`owner_requests` / `owner_updates`: the session user must be an ACTIVE owner** (D3).<br>• Inserted only as QUEUED, with every result field empty.<br>• CHECKs: ≤ 50,000 rows, the storage key bound to its org and job, file purged at most 1 h after creation, a ready job's window ≤ 15 minutes and before the purge.<br>• `app.export_job_guard`: state machine, single-use download, results fixed once ready.<br>• `app.export_job_quota`: 5 a day |
| `app.export_files_due(int)` and `app.export_file_deleted(uuid, uuid)` | • Definers owned by `crm_definer`, with a fixed `search_path`.<br>• **EXECUTE for `crm_cleanup` only**; revoked from PUBLIC, `crm_app`, `crm_auth` and `crm_platform`.<br>• `crm_definer` gets column-limited SELECT and UPDATE, and its update policy only matches rows that are due |

**Not changed:**
- no existing policy, role, grant or definer function;
- no new role;
- nothing for `crm_auth` or `crm_platform`;
- no DELETE grant anywhere;
- `crm_cleanup` gains EXECUTE on the two new functions only (it already has USAGE on schema `app`).

### B.2 Audit of revision 1: defects found and fixed

| # | Defect in revision 1 | Fix |
|---|---|---|
| F1 | A deleted lead was not frozen | The guard freezes merged **or** deleted leads |
| F2 | A lead could be merged into an archived lead | The target must be unarchived; restoring is a separate, explicit decision (D2) |
| F3 | **Race:** concurrent "A into B" and "B into A" could both pass the check and form a cycle | The target is locked `FOR UPDATE`; READ COMMITTED re-checks it, and a crossing pair deadlocks and one transaction aborts |
| F4 | Select options were not type-checked | A CHECK requires 1–100-character strings |
| F5 | The 30-field count could be bypassed under REPEATABLE READ (stale snapshot) | The trigger refuses REPEATABLE READ. The app uses READ COMMITTED (no `isolationLevel` anywhere); SERIALIZABLE is safe |
| F6 | Pair uniqueness was ordered, so (A,B) and (B,A) could both exist | Unique index on the unordered pair |
| F7 | A case could be marked MERGED or RESTORED without that happening | `duplicate_match_guard` checks the lead state in the same transaction; new cases must name leads in the right state |
| F8 | Export filters were unbounded | ≤ 4 KB object |
| F9 | **The window CHECK passed when `finished_at` was NULL** (NULL is not false), leaving `expires_at` unbounded | READY/DOWNLOADED require every result field; window ≤ 15 min and ≤ purge time |
| F10 | **Retention was "now() + 1 h" on every update**, so each update could extend the file's life | Absolute CHECK `purge_file_after <= created_at + 1 h` (`created_at` is not updatable); the guard lets retention only shrink |
| F11 | Start, finish and expiry times could be set to any value, and a READY job's results could be rewritten | The guard requires `started_at = now()` and `finished_at = now()`, a window ≤ 15 min, fixed results once READY, and the file marker set once, at now(), only on a finished job |
| F12 | No database rate limit | `export_job_quota`: 5 per requester per 24 h, under an advisory lock |
| F13 | **No insert policy on review cases:** a session could insert a case already "resolved" by someone else | RESTRICTIVE `first_state_open`. The update policy now requires a real resolution |
| F14 | Owner-only export was enforced only in code. Also, **cleanup could not mark export files** (`requester_only` hides rows from system sessions), so purged jobs would have been returned for ever | Owner policies on insert and update. A second definer function (`export_file_deleted`) marks only due rows and closes the job: QUEUED/READY → EXPIRED, RUNNING → FAILED |

### B.2a Amendment A1 (applied with 0006): search text removed when an export finishes

The stored filters may include the lead list's free-text search, which can be a name or phone number.
- **`export_job_guard`:**
  - `filters` may change only by dropping `q`;
  - a job cannot enter DOWNLOADED, EXPIRED or FAILED while `q` is stored;
  - finished jobs stay frozen.
- **Permissions:** `crm_app` gains UPDATE on `export_job.filters`; `crm_definer` gains SELECT and UPDATE on `filters`.
- **Cleanup:** `app.export_file_deleted` drops `q` when it closes a job.
- **Audit:** keeps only `search: true` (`exportAuditFilters`).
- Covered by tests (§G).

Claim-first download is kept: the download is claimed (READY → DOWNLOADED) before any byte is streamed through the server. A failed transfer uses the single download.

### B.3 Invariants (now tested: §G.2; application-level items: §G.3)

- **Tenant isolation:**
  - all three tables have RLS enabled and forced, with `tenant_isolation` for `crm_app` and `maintenance` for `crm_migrator` only;
  - every foreign key to a lead, enquiry or member is composite with `org_id`;
  - trigger lookups run as the invoker, so RLS hides other orgs;
  - the definer functions return ids and keys only, and mark only the given org's due row.
- **Actor identity:**
  - creators, detectors and resolvers must be `app.current_user_id()`;
  - timestamps must be `now()`;
  - actor columns are not updatable.
- **History:**
  - merge is a pointer only; no history table gains UPDATE or DELETE;
  - merged leads are frozen and unmerge is impossible.
- **Exports:**
  - only an active owner who requested the job can see, build or download it;
  - one download within ≤ 15 min, before the purge;
  - the file is purged ≤ 1 h after creation.
- **Unchanged:**
  - the hard-delete column stays ungranted;
  - `crm_auth`, `crm_platform` and `crm_cleanup` get no table access.

**Tests to add after approval:**
- `db-roles.test.ts` and `cleanup-grants.test.ts`: the new tables and functions.
- Isolation: cross-org reads and writes on each new table.
- Guards: merge freezing, the concurrent crossing merge, the 30-field race, double resolution, and outcome checks.
- Exports: owner and requester policies, a double download claim, expiry and retention, the quota, and the cleanup marker.

## C. Owner decisions (approved 2026-10-24)

1. **D1 Merge by reference.**
   - The merged lead becomes a frozen tombstone pointing at the survivor.
   - Timeline, enquiries and notes are read through the pointer (`timelineLeadIds`); no historical row is rewritten.
   - Chains are allowed and depth-capped at 10.
2. **D2 Archived leads are never auto-restored.**
   - A matching enquiry is attached to the archived lead, which stays archived.
   - An `ARCHIVED_ENQUIRY` case opens; an authorised user (`lead.archive`) restores it or keeps it archived.
   - Archived leads still count for duplicate checks (the open-phone unique index is unchanged).
3. **D3 Exports:**
   - Owner only;
   - at most 50,000 rows, refused rather than truncated;
   - watermarked with the requester;
   - visible only to the requester;
   - one download within 15 minutes;
   - the file purged within 1 h.
4. **D4 Hard delete:** excluded from M5; it needs a separate proposal.
5. **D5 Custom fields:** at most 30 active, strict validation, no coercion, unknown and archived keys refused.

## D. Questions from revision 2, now settled

1. **Failed transfers:** claim-first is kept (owner, 2026-10-24).
2. **Search text:** removed on finishing, enforced in the database (A1).
3. **File size:** the 20 MB limits are unchanged. An oversized export fails with `EXPORT_FILE_TOO_LARGE`. Export files live under the distinct `exports/` path in the private bucket.
4. **Demoted owner:** the worker cannot update the job (tested). Cleanup closes it within 1 h (tested on due jobs).
5. **Notes and enquiries on merged leads:** redirected by the application and **not blocked by the database** (§G.3).
6. **Owner notification of exports:** deferred (needs a `notification_type` change).
7. **Bulk archive:** synchronous up to 500, a job above that; tags deferred (OD-05).

## E. Command and service layers (2026-10-25)

Built below the UI and tested on local `crm_test`.

| Slice | Code | Tests | Status |
|---|---|---|---|
| 1 Archive/restore + duplicate review | `leads/hygiene.ts`. `archiveLead` and `restoreLead` (Owner/Admin, version-checked, archive time set by the database, ARCHIVED/RESTORED timeline entries, audit). Archived and merged leads are refused by edit, stage, note and assignment commands (`assertWritable`). D2 routing: manual attach, reported duplicate and import attach keep the lead archived and open one `ARCHIVED_ENQUIRY` case (concurrency-safe). `listDuplicateCases` and `resolveDuplicateCase` (per-type permission and scope; a conditional update on OPEN, so a concurrent resolver gets CONFLICT) | `lead-archive-review` 18/18 | Service done |
| 2 Merge | `leads/merge.ts`. `previewMerge` and `mergeLeads`: phone locks for both leads (sorted), then row locks in id order, then a re-read. Every conflict needs an explicit choice; invalid ranges are refused. Tombstone first, then survivor. The merged lead's assignment spell is closed. Review cases are closed as MERGED or DISMISSED (an archived case as KEPT_ARCHIVED). MERGED entries on both leads, audit with field names only. `canonicalLeadId` takes FOR KEY SHARE, so note and enquiry writes by id wait for a merge and are redirected. `getTimeline` reads through merge pointers (`fromMergedLeadId`). The lead list hides tombstones | `lead-merge` 12/12, `merge-redirect` 6/6 | Service done |
| 3 Custom fields | `leads/custom-field-commands.ts`. List (lead.read). Create, update and archive/restore (org.settings.manage): key and type are immutable, an option in use cannot be removed, the 30-active limit is mapped from the database. `setLeadCustomFields`: strict, no coercion, archived and unknown keys refused, a required field cannot be cleared, definitions locked FOR SHARE. Manual create enforces required fields; imports are exempt (they do not map custom fields). `getLead` returns values, archive and merge state | `custom-fields` 16/16 | Service done |
| 4 Exports | `modules/exports`: `requestLeadExport` (Owner, list filters, 50,000 pre-check, quota mapped from the database, audit without the search text), `listMyExports`, `downloadLeadExport` (claim-first, checksum verified). Worker-only `processor.ts` builds as the requester (re-checked before start and before READY), stores under `orgs/<org>/exports/<job>/`, fails clearly on more than 50,000 rows, more than 20 MB or a storage error, and drops the search text at READY or FAILED. Worker-only `cleanup.ts` deletes the file, then `app.export_file_deleted` (crm_cleanup). Supporting pieces: outbox event `export.requested`, the `exports` queue, the worker wiring, and a 5-minute sweep. Route `GET /app/leads/exports/[id]/download` (401, 404, 410 when expired or used, 503 when delivery fails) | `lead-export` 14/14 | Service done |

**Checks run:**
- full integration suite 403/403 (21 files);
- unit tests 611/611;
- typecheck, ESLint and Prettier clean;
- the identity of all five test roles on `crm_test` verified before the database runs.

**Not done yet (needed before M5 can be signed off):**
- **UI:** archive/restore controls, the duplicate review queue page, the merge preview and conflict choices, the custom-field settings and lead-form inputs, the export request and "my exports" page, and a filter for showing archived leads in the list.
- **E2E acceptance**, including a real-storage export check (not run).
- **Bulk actions** (FR-063: bulk archive), not started.
- **Duplicate detection** that creates pair cases (PHONE_ALT/EMAIL/NAME_SIMILAR): no producer yet; cases are only created in tests.
- **Export integration gaps:**
  - The 50,000-row cap is covered by unit tests and the pre-check, not by a 50,001-lead integration run.
  - Download expiry is tested at the database level, not through the service with a real 15-minute wait.
- **Known limits, documented:**
  - Notes and enquiries are not blocked in the database for tombstones (§G.3).
  - Deactivation handover still moves archived leads (offboarding must not leave leads with a departed user).
  - A RUNNING export whose worker crashed is closed by cleanup within 1 h; there is no retry.

## F. Apply record (2026-10-24)

1. The reviewed draft was moved to `prisma/migrations/0006_hygiene/migration.sql`:
   - part 1 regenerated by `prisma migrate diff` from the updated `schema.prisma` (additions only, no drops);
   - part 2 is the audited hand-written SQL plus A1.
   - `prisma/proposed/` was removed. `prisma generate` was run.
2. **Identity check before applying:**

   | Item | Value |
   |---|---|
   | Container | `cbr-crm-postgres-1` (`postgres:18.6`) published on 127.0.0.1:55432 |
   | Database | `crm_test` |
   | Role | `current_user = crm_migrator`, not superuser, no BYPASSRLS |
   | Prior migrations | 0001–0005 applied, none unfinished |
   | Prerequisites | `crm_cleanup` exists; `export_job` absent |

3. **Rehearsal:** a dry run of the full file inside a transaction, then ROLLBACK: it succeeded and left nothing behind.
4. **Apply:** `prisma migrate deploy` applied `0006_hygiene` (only), and `migrate status` reports the schema up to date.
5. **`crm_dev`** was checked read-only afterwards: 0001–0005 only, no `export_job`.

## G. Results (actual)

### G.1 Commands run

| Check | Result |
|---|---|
| `hygiene-schema.test.ts` (new, crm_test) | **63/63** |
| `merge-redirect.test.ts` (new, crm_test) | **6/6** |
| Full integration project (crm_test; 0006 changed `lead`) | **343/343** (17 files; includes the two new files) |
| Unit suite | **611/611** |
| Typecheck, ESLint, Prettier | clean |
| e2e suite | **not run** in this step |

**Failures found and how they were handled:**
- `import-cleanup-role.test.ts` and `cleanup-grants.test.ts` failed because they asserted that `crm_cleanup` holds exactly one function. 0006 deliberately adds the two approved export-cleanup functions. Both now assert the new **exact** list; neither was loosened. `cleanup-grants.test.ts` also gained static checks for the export functions.
- One fixture in `hygiene-schema.test.ts` inserted a DOWNLOADED job that still held `q`, a state the application cannot create. The cleanup function correctly hit the finished-job freeze. The fixture was corrected; no database rule changed.

### G.2 Guarantees proven by database tests (`hygiene-schema.test.ts`)

**Applied state:**
- RLS is enabled and forced on all three tables.
- The policy set is exactly as reviewed, and `lead`'s policies are unchanged.
- Trigger functions run as the invoker and the two cleanup functions as definers owned by `crm_definer`, all with `search_path = pg_catalog, pg_temp`.

**Grants:**
- `crm_app`: SELECT, INSERT and exact column UPDATE lists; no table UPDATE, DELETE or TRUNCATE.
- `lead`: `archived_at`, `merged_into_lead_id` and `custom_fields` are updatable; `deleted_at` is not (D4).
- `crm_auth`, `crm_platform` and `crm_cleanup` have no privilege of any kind on the new tables.
- `crm_definer` has only its export cleanup columns.
- The cleanup functions are executable by `crm_cleanup` only, and nothing new is executable by PUBLIC.
- `crm_cleanup` can execute exactly three functions.

**Cross-tenant negative controls:**
- Org A cannot read, update or insert org B rows in any new table.
- A case cannot name another org's leads.
- A session without an org context sees nothing.

**Lead guard:**
- Archive time must be now, and restoring clears it.
- A merged lead is frozen, and unmerge is refused.
- The merge target must be live, unmerged, unarchived and in the same org.
- A deterministic crossing merge refuses the second transaction.
- In 10 rounds of truly simultaneous crossing merges, at most one won and there was never a cycle.

**Custom fields:**
- Rows are attributed to the session user at the transaction time.
- Key, type and options CHECKs hold; keys are never reused; key and type are not updatable.
- At most 30 active per org: a concurrent 30th/31st pair cannot both commit, and other orgs are unaffected.
- Un-archiving past the limit is refused.
- REPEATABLE READ is refused.
- Lead values must be an object of at most 16 KB.

**Duplicate review:**
- Cases start OPEN, attributed to the session user or the system.
- One case per unordered pair; no self-pairs; merged leads are refused.
- A case is resolved once, by the session user; two concurrent resolvers record exactly one resolution.
- MERGED, RESTORED and KEPT_ARCHIVED are accepted only when true.
- An archived case needs an archived lead and that lead's enquiry, with one open case per lead.
- **An archived lead stays archived unless explicitly restored.**

**Exports:**
- Owner only; visible only to the requester, including against another owner of the same org and system sessions.
- Insert restrictions hold; the storage key must name its org and job under `exports/`; the quota is 5 per requester.
- Times must be the transaction time; the window is at most 15 minutes; results are fixed once READY; retention can only shrink; `file_deleted_at` cannot be set by `crm_app`.
- Two simultaneous claims record exactly one download, and never again.
- A download after the window is refused.
- A demoted owner cannot advance their job.
- **A1:** no terminal state while `q` is stored; filters can only lose `q`; filters are frozen once finished.

**Cleanup:**
- Due files are listed across orgs, ids and keys only.
- `crm_cleanup` cannot read or write `export_job`, and `crm_app` cannot call either function.
- Marking works only for a due job of the given org, once. It closes QUEUED/READY → EXPIRED and RUNNING → FAILED, and drops `q`.

### G.3 Protections that are application-level only (not enforced by the database)

| Protection | Where | Evidence | Database |
|---|---|---|---|
| Notes and enquiries given a merged lead's id go to the surviving lead (chains followed) | `addNote`, `attachEnquiry` via `canonicalLeadId` | `merge-redirect` tests 1–3 | **Not enforced:** a direct `crm_app` insert naming a merged lead is accepted (test 6 documents this) |
| Phone-matched writes (`createLead`, `reportDuplicateToOwner`, import attach) never target a merged lead | `OPEN` filter in `findOpenMatch` / `openLeadsByPhone` | `merge-redirect` test 4 | Partly enforced: the open-phone unique index excludes merged leads. A merge racing a phone-matched attach needs the merge command to take the phone locks (§E) |
| Updates to a merged lead fail | `changeStage` and the other update commands | `merge-redirect` test 5 | **Enforced** by `lead_hygiene_guard` (also §G.2) |
| Archived-lead routing (D2) | `routeMatchedEnquiry` (pure; not wired) | unit tests | Outcome checks enforced; routing itself is not built |
| Export audit without search text; 20 MB file refusal; claim-first streaming | `export-job.ts` (pure) | unit tests | Not applicable / not built |

Not done in this step: `crm_dev`, any managed database, e2e and the real Supabase bucket.

## H. UI, remaining requirements and acceptance (2026-10-25)

No new migration, grant or policy was needed: everything below runs on the approved 0006 schema.

### H.1 UI routes

| Route | What | Access |
|---|---|---|
| `/app/leads` | **Show** filter (active, default / archived / all). Archived badge. Bulk-archive checkboxes with a confirmation showing the exact count. Links to *Review duplicates* and *Export these leads* | lead.read. Bulk: lead.bulk_update + lead.archive. Links shown per permission |
| `/app/leads/[id]` | Archived/Merged badges. Merged banner linking to the survivor. Archive/Restore with confirmation, using the shown version. *Merge a duplicate into this lead* entry. Custom-fields card (edit, or read-only; values of archived fields shown read-only). Timeline entries for ARCHIVED/RESTORED/MERGED, with history from merged leads labelled "from a merged lead". Write actions hidden for archived/merged leads | as before; server re-checks |
| `/app/leads/review` | Open/resolved cases: the leads (names only for leads in scope), the reason, the status. Archived cases: *Restore* (confirmation) / *Keep archived*. Pairs: *Review merge…* (opens the preview) / *Not duplicates*. Refreshes after every decision, so a concurrent conflict shows the case as resolved | lead.merge or lead.archive; 404 otherwise |
| `/app/leads/merge?survivor=&merged=` | Who survives and what happens: history preserved and combined by reference, cannot be undone. Required radio choice per conflict, no defaults. Fills and combined localities. *Keep the other lead instead* | lead.merge; 404 for other orgs or out of scope |
| `/app/settings/custom-fields` | Add a field (key/type fixed, keys never reused; explained), "n of 30 active", edit label/required/options, archive/restore | org.settings.manage (Owner/Admin) |
| `/app/leads/new` | Active custom fields in the form; required ones marked | lead.create |
| `/app/leads/import/[id]` | Mapping lists active custom fields (with type hints); required ones must be mapped | lead.import |
| `/app/leads/exports` | Limits explained before the request (50,000 rows, 20 MB, one download within 15 min, file deleted within 1 h, 5 a day). Request for the list's filters (the search text is not shown back). *My exports* with the server state (Preparing / Ready / Downloaded / Expired / Failed + reason). *Download (once)* | lead.export (Owner); 404 otherwise |

The UI reuses the existing primitives (`ActionForm`, `ActionFormButton`, `Card`, `Field`, …); no new UI framework. Server actions convert form values by each custom field's declared type: a non-number text is sent as text and refused by the server, never coerced.

### H.2 Remaining functional requirements

| Item | Implementation | Status |
|---|---|---|
| **Bulk archive (FR-063)** | `bulkArchiveLeads`. Owner/Admin (lead.bulk_update + lead.archive). A selection of ≤ 100 items, each with its version. Rows locked in id order. **All or nothing**: a stale item gives CONFLICT and an archived/merged item gives RULE_VIOLATION, both naming the leads and archiving nothing. One audit entry `lead.bulk_archived` (count + ids, no personal data); one ARCHIVED timeline entry per lead | Done for selections. FR-063's "job above 500 / by filter" is **not** built (selections stay ≤ 100, like bulk assign) |
| **Automatic duplicate detection** | `detectEmailDuplicates`, called from `insertNewLead`, so manual create and import share it. An **exact email** match (citext equality; ILIKE avoided so `_`/`%` are not wildcards) with another live lead opens one EMAIL pair case. A per-(org, email) advisory lock makes concurrent creates safe; ON CONFLICT on the unordered-pair index makes it idempotent. At most 10 cases per new lead. The creator learns nothing about the other lead | Done for email. **Documented ambiguity:** phone matches with an OPEN lead already attach the enquiry; with a closed lead they link the returning customer (previousLeadId). There is no approved rule for a shared phone *without* those paths, nor for names, so PHONE_ALT and NAME_SIMILAR cases have no producer. Name alone is never conclusive |
| **Custom fields in imports** | Mapping accepts `custom:<key>` for active fields only (unknown/archived refused, required must be mapped; suggested from a matching header). Each cell is parsed by the declared type with documented rules (digits; YYYY-MM-DD; yes/no or true/false; option ignoring case; `;` between several options), then the same strict schema as manual create, required included. Stable row codes CUSTOM_FIELD_INVALID / CUSTOM_FIELD_REQUIRED on field `CF_<key>`, with digits written A–J to satisfy the existing `import_row_result.field` CHECK, so **no migration**. The import step re-plans with the current definitions, and `commitImportBatch` re-checks every new lead (definitions locked FOR SHARE), so the direct API cannot bypass required fields (row FAILED). Dry runs write nothing | Done |
| **Export-worker recovery** | A crashed build is redelivered by BullMQ (lock 60 s). A RUNNING claim older than 90 s can be claimed again. Every claim bumps `version`, and READY/FAILED are fenced by it, so a stale builder can neither publish nor fail. The claimant removes any partial object at its own key before uploading (the job was never READY, so nothing was downloadable). At most one file exists; the checksum-verified single-use download is unchanged | **Safe** within the tested scenarios (crash then re-claim; slow builder overtaken). No database change (the 0006 guard allows RUNNING→RUNNING) |

### H.3 Tests run (actual)

| Suite | Result |
|---|---|
| Database identity before every database run (5 roles → `crm_test` on 127.0.0.1:55432, migrations 0001–0006) | verified |
| `m5-completion.test.ts` (new): archive view, bulk archive (atomic, roles, stale/ineligible, other org, limits, concurrent overlap), email detection (manual, import, other org, concurrency, name-only, `_`), import custom fields (required mapping, CSV + XLSX valid/missing/invalid, dry run, commit-time re-check, direct API), export recovery (crash + lease, fencing) | 17/17 |
| `custom-fields-import.test.ts` (new unit), `export-rows.test.ts` (new unit, 50,000 / 50,001 with a stub transaction), list-query archive view | pass |
| `m5-routes.test.ts` (new E2E, built server + real worker + fake storage) | 9/9 |
| Full E2E regression (6 files) | **80/80** |
| Full integration regression (22 files) | **420/420** |
| Unit | **635/635** |
| Typecheck, ESLint, Prettier | clean |

E2E coverage: archive/restore and the archive view, bulk archive (roles, other org), detection via the create action plus review page visibility, another org's queue and decision (404/NOT_FOUND), concurrent resolution (one OK, one CONFLICT), the merge page (conflicts listed, 404 for other orgs and Executives, refused without choices, merged by reference and shown on the survivor's timeline), custom fields (settings 404 for Executives, FORBIDDEN for Managers, required and forged values refused, typed values stored), and exports:
- Owner-only request, worker generation, search text dropped, audit without it;
- no storage URL, key or service key in the page;
- download 404 for an admin or another org, anonymous redirected to sign-in, the owner gets 200 with a matching checksum, watermark and neutralised formula, then 410 the second time;
- expired → 410 (a past-window row inserted as a fixture, so no 15-minute wait);
- cleanup through crm_cleanup;
- a suspended Admin cannot act.

**Assertions changed, as verified intentional contract changes (still exact):**
- `custom-fields.test.ts`: imports now refuse a missing required custom field (previously documented as exempt).
- `lead-export.test.ts`: stored export filters now include `archived: 'active'`.
- `m5-routes`: an anonymous download is redirected to sign-in by the app proxy (same as M4 `issues.csv`), not 401.

### H.4 Still open

- **Real-storage acceptance (not run; needs separate approval).** Proposed test:
  - one synthetic org with ≤ 5 synthetic leads;
  - the web server and worker against the real private bucket;
  - request an export → READY;
  - download once via `/app/leads/exports/[id]/download` and compare the checksum; the second download returns 410;
  - check the object key is `orgs/<synthetic-org>/exports/<job>/<32hex>.csv`;
  - make the job due (schema owner, local `crm_test` only) and run the crm_cleanup sweep;
  - confirm the object is gone (stat → not found).
  **Cleanup plan:** record every key written, delete each by its exact key (idempotent), then list the prefix `orgs/<synthetic-org-id>/` and confirm it is empty. Nothing outside that prefix is touched.
- **Covered by integration but not by E2E over HTTP:** an import with custom fields; oversize export failure (storage refusal plus the unit 20 MB check); concurrent merge and racing enquiry; a multi-item bulk archive (the E2E helper sends one `item` field).
- **Not built:** FR-063 bulk archive by filter / job above 500; PHONE_ALT / NAME_SIMILAR producers (no approved rule); export owner notification.
- **No browser-rendered checks:** pages were checked by HTTP render and actions only; there was no visual or real-browser pass.
- **Documented limits remain:**
  - note/enquiry redirection for merged leads is application-level only (§G.3);
  - deactivation handover still moves archived leads.

M5 is **not signed off**: see §I for the real-storage acceptance and the real-browser review, and their open items. M4's P6 (a real brokerage export) is separate and still open.

## I. Real-storage export acceptance and real-browser UI review (2026-10-25)

The owner approved this as a narrowly scoped acceptance run. Every result in this section ran against the **real** private Supabase bucket (`crm-imports`) in a **real Chrome browser** (via the Claude-in-Chrome extension). The local fake storage played no part. The integration and E2E results in §H.3 are separate evidence and are not repeated here.

### I.1 Environment

| Item | Value |
|---|---|
| Database | Local `crm_test` on 127.0.0.1:55432 only.<br>The identity was **queried**, not inferred from URLs: `current_user` and `current_database()` for crm_app, crm_auth, crm_platform, crm_cleanup and crm_migrator; migrations 0001–0006 applied, none unfinished.<br>`crm_dev`, Neon and every managed database were not touched. Migration 0006 was not applied to `crm_dev` |
| Processes | One built standalone web server and **one** worker.<br>**Web:** port 3300; the build from 2026-10-25 02:37, newer than every source file; CSP `connect-src 'self' https://<ref>.supabase.co`.<br>**Worker:** `tsx src/worker/main.ts`, with the crm_cleanup sweep.<br>**Queue:** Valkey db 2, so no other environment's queue was shared.<br>No duplicate or orphaned processes before, during or after |
| Storage | The existing private bucket and secret key from `.env` (values never printed). Supabase database services were not used |
| Test data | The existing synthetic acceptance org (AcceptA) lives only in `crm_dev`. The 8 orgs already in `crm_test` are integration-test leftovers whose authenticator secrets were never kept, so none of them could sign in.<br>A synthetic org pair was therefore seeded in `crm_test` with the existing test factory:<br>• **AcceptM5A:** Owner, Admin, Manager, two Sales Executives, HR;<br>• **AcceptM5B:** an Owner;<br>• **5 synthetic leads** in AcceptM5A: `Synthetic Buyer One` to `Four`, plus one formula-like name `=HYPERLINK("http://example.invalid")`; phones +91 98000 00101–105.<br>No real customer data |

**Worker start-up side effect (recorded, harmless).** On start, the worker:
- drained 16 leftover outbox events from earlier `crm_test` runs (all export steps, outcome `noop`);
- found 14 leftover `crm_test` export jobs past their purge time in its first sweep (`due 14, deleted 14, refused 0, errors 0`).

Those files had only ever existed in the integration tests' in-memory storage, so deleting their exact keys matched nothing in the real bucket. Full bucket listings before and after were **identical**: 4 unrelated import objects under other orgs, untouched.

### I.2 Real export workflow

| # | Check | Result |
|---|---|---|
| 1 | The synthetic Owner signs in (password and TOTP on the real screens), searches the list by the shared phone digits `980000010` (all 5 leads), opens **Export these leads** and clicks **Request export** | "Export requested". Job `4add55af…` is created for AcceptM5A, with `requested_by` = the Owner |
| 2 | The request is authorised for the active Owner and scoped to the org | The job row and audit entries carry AcceptM5A's org id and the Owner's user id.<br>Audit `lead.export_requested` metadata: `rows 5, filter_search: true, filter_archived: active`. The search text itself is **not** stored.<br>Stored filters after the request: `{"archived":"active"}` (search text dropped) |
| 3 | The real worker generates the CSV and writes it to the real bucket | READY 2.7 s after the request (`export step: ready`). Audit `lead.export_ready`: 5 rows, 1073 bytes, 19 columns, 4 PII columns |
| 4 | Object path | `orgs/01a171d7-98f8-7923-90ff-fe1e4a55ddf1/exports/4add55af-07e6-4c0b-8314-c7e68b303ed6/c571997ecbe648543cc1e5d194650b63.csv`, the **only** object under the org prefix; 1073 B, `text/csv` |
| 5 | Download once through the real route: click **Download (once)** in Chrome (a plain `<a>` to `/app/leads/exports/<id>/download`, so no prefetch) | Chrome saved `lead-export-4add55af.csv` (1073 B).<br>**SHA-256 `a72e9982…856f3e6c` matches the job's recorded checksum and the bucket object's checksum**, and the file is byte-identical to the bucket copy.<br>Audit `lead.export_downloaded`; the job is DOWNLOADED (version 4) |
| 6 | Second download attempt | **410** "This export has expired or was already downloaded. Request a new export." |
| 7a | Admin of the same org (no `lead.export`) | Exports page **404** and download route **404**, with the browser cache bypassed (see I.4 F1). No *Export these leads* link |
| 7b | Owner of AcceptM5B | Downloading either AcceptM5A job gives **404** (not 410, so the jobs' existence is not revealed). *My exports* is empty, and no AcceptM5A job id or name appears in the page |
| 7c | Sales Executive of AcceptM5A | Exports page and download route **404**; no export link |
| 7d | Signed out | Exports page and download route **307** to `/login?next=…` |
| 8 | Exposure | **Browser:** the rendered HTML, the 11 loaded scripts, localStorage, sessionStorage and JS-visible cookies contain no `sb_secret`, `service_role`, `SUPABASE`, `supabase.co`, `storage/v1`, `token=`, object path or search digits. The only JS-visible cookie, `_awa_aid`, belongs to another app on localhost.<br>**Logs:** web and worker logs contain no service key or its 12-character prefix, no `sb_secret`, `token=`, storage host, search digits, database password or connection URL.<br>**Response:** the download is sent with `private, no-store`.<br>**Search text:** it appears only in the Owner's **own** page as their own filter (the URL `?q=`, the hidden `query` field, the Refresh and Change-filters links), as for every M2 list filter. It is never shown as text and never stored |
| 9 | Contents | **Watermark:** `"CONFIDENTIAL lead export for AcceptM5A, requested by AcceptM5A-owner at <time>, 5 rows. Do not share."`<br>**Rows:** the header, then exactly the 5 synthetic leads (UTF-8 with BOM).<br>**Neutralisation intact:** the formula cell is `"'=HYPERLINK(""http://example.invalid"")"` and phones are written `'+91…` |

**A second synthetic export (`f2468753…`) was also run.**
- **Why:** the browser tool's network log had reported the first click as HTTP **503**.
- **What was done:** the web server was restarted (same build, same environment) with a diagnostic preload that logs only the method, path and status of storage requests. A second export was then requested and downloaded.
- **Its result:** both storage calls returned 200; the browser-side SHA-256 matched the job checksum and the bucket object; the response was `private, no-store`.
- **Outcome:** the file saved from the first click was found afterwards and **matches its checksum exactly**. Since only one claim can succeed, the first download did succeed; the "503" was a misreport by the tool, not an application failure.

Quota used: 2 of 5.

### I.3 Cleanup through the restricted role

| Step | Result |
|---|---|
| Before the run | Prefixes `orgs/<AcceptM5A>/` and `orgs/<AcceptM5A>/exports/`: **0 objects**. Whole bucket: 4 objects, all `orgs/*/imports` of other orgs |
| Make job 1 due without weakening any rule | While job 1 was READY, the schema owner (local `crm_test` only) set `purge_file_after = expires_at`. That is the earliest value the `expires_at <= purge_file_after` CHECK allows.<br>`export_job_guard` accepted it (retention may only shrink), and a later attempt to grow it again was **refused** ("retention cannot grow").<br>No trigger, policy or grant was changed |
| Job 1 sweep | The real worker sweep ran via **crm_cleanup** at 07:16:52 UTC, 12 s after the purge time: `due 1, deleted 1, refused 0, errors 0`.<br>`file_deleted_at` = 07:16:52.913, and the object is **not found** in the bucket |
| Job 2 | It was downloaded before it could be shortened. A finished job is frozen, so it follows the normal 1-hour retention (purge 08:06:25 UTC). The real worker sweep via **crm_cleanup** ran at 08:07:15 UTC: `due 1, deleted 1, refused 0, errors 0`. `file_deleted_at` = 08:07:15.140, and the object is **not found** |
| Keys created by this run | Exactly the two export objects above. No emergency deletion was needed, and nothing was deleted by hand |
| Final state | At 08:09 UTC, `orgs/<AcceptM5A>/exports/` and `orgs/<AcceptM5A>/` hold **0 objects** (the org prefix held nothing unrelated before the run). The **whole-bucket listing is identical** to the pre-run snapshot: the 4 unrelated import objects are unchanged |

### I.4 Findings

**F1: download route error responses can be cached (security; fix proposed, not applied).**
- **Cause:** `src/app/(app)/app/leads/exports/[id]/download/route.ts` sets `cache-control: private, no-store` only on its 200 response. Its 401, 404, 410 and 503 responses carry no cache header, and a 410 may be cached heuristically.
- **Observed:**
  - after the Owner's second download (410) in this browser, the Admin signed in later in the same browser;
  - the Admin was shown that **cached 410** (`transferSize 0`), although the server answers the Admin **404** (confirmed with `cache: 'no-store'`).
- **Impact:** no file data is exposed, because the 200 is `no-store`. But one user's per-user response (status and message) can be replayed to the next user of a shared browser.
- **Proposed fix:** set `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff` on every response from that route, with a test that every status carries them.
- Not changed during acceptance, so that the build under test stayed fixed.

**UI review (real browser, AcceptM5A, desktop width 1536 px).**

| Route | Reviewed | Visible problems |
|---|---|---|
| `/app/leads` | The Show filter (active, archived or all), the Archived badge, bulk checkboxes, and a bulk confirmation stating the exact count ("Archive 2 selected leads? They can be restored later."; cancelled, nothing archived) | None found |
| `/app/leads/[id]` | Archive with confirmation, the Archived badge and banner, read-only requirements, the Restore card, the custom-fields card | **U1:** right after archiving, the new Restore card shows a green **"Restored."** although the lead is archived. The action button's state carries over to the button that replaces it.<br>**U2:** a stale tab's Archive is correctly refused ("This lead is already archived"), but the page keeps showing the editable view, and the button jumps sideways when the error appears |
| `/app/leads/review` | The empty state; an ARCHIVED_ENQUIRY case, raised by attaching an enquiry with the archived lead's phone (no new lead); Keep archived; a concurrent Restore from a stale tab | The server is correct: the case is KEPT_ARCHIVED, the lead is still archived, and there is one `lead.duplicate_resolved`.<br>**U3:** the stale tab gets **no message**. The case silently disappears from Open, so the user is not told their Restore was not applied |
| `/app/leads/merge` | The preview text (survivor, read-only pointer, history combined by reference, cannot be undone); one Name conflict with no default; submitting without a choice is refused | **U4:** the error shows the internal field name ("fullName: Choose which value to keep").<br>**U5:** "Filled from the duplicate (1)" also lists "Localities (combined) —", an empty item.<br>There is no second confirmation before the irreversible merge (the preview page is the review step); the owner should decide whether one is wanted |
| `/app/settings/custom-fields` | "0 of 30" and "1 of 30", the empty state, adding a required text field, an invalid key | The browser check gives only the generic "Please match the format requested" (the hint text is visible).<br>After a **server** error:<br>• **U6:** all inputs are cleared, so the valid label is lost;<br>• **U7:** the error or success box sits inside the form grid, so Label and Key swap columns;<br>• **U4** again ("key: …") |
| `/app/leads/new` | The required custom field is listed; submitting without it (browser `required` removed) | The server refuses on the right field and no lead is created (still 5).<br>**U8:** the message is the raw schema text "Invalid input: expected string, received undefined", and the field is not marked `aria-invalid`.<br>**U6:** name and mobile are cleared.<br>**U9:** attaching to the archived lead says "An open lead with this phone number already exists", although that lead is archived |
| `/app/leads/exports` | Limits explained; request; Preparing → Ready to download (5 leads, until …); Download (once); Refresh | None found (search text in the URL is noted under I.2 #8) |

**Permission visibility (real browser):**
- **Sales Executive:** review, merge, custom-field settings, exports and download all give 404. No review or export links, no bulk controls, no archive or merge on the lead page, and no *Custom fields* nav entry.
- **Admin:** exports gives 404 and there is no export link. The review link is shown, because the Admin has `lead.merge` and `lead.archive`.

**Not reviewed:**
- **Small screens.** The Chrome window could not be resized (it is maximised; `resize_window` had no effect), a phone-width popup was blocked, and the app's own headers refuse framing. No small-screen result is claimed.
- **Native confirmation dialogs** were stubbed (`window.confirm` recorded the text and answered), because a real dialog blocks the browser automation. The wording was checked; the native dialog itself was not.
- **Loading states** were seen only for the export (Preparing → Ready). Other actions finished too fast to show one.

**Screenshots** (synthetic data only, no secrets) were saved by the browser tool under `C:\Users\aDMIN\AppData\Local\Temp\claude-chrome-screenshots-471GkP\`, from `screenshot-1792911613394-0.jpg` to `screenshot-1792912843642-18.jpg`. They show:
- the lead list;
- the export page before and after the request, and Ready with Download (once);
- custom-field settings: empty, browser validation, server validation, field added;
- the new-lead refusal;
- the lead page before and after archiving, and the stale refusal;
- the review queue with a case and empty;
- the merge preview and refusal.

### I.5 Status

- **Real-storage export acceptance passed** for the request, authorisation, worker generation, object path, the single checksum-verified download, single use, isolation and formula neutralisation.
- **Cleanup through crm_cleanup passed** for both jobs.
- **Open:**
  - F1 (cache headers on download-route errors; fix proposed);
  - U1–U9 (UI);
  - small-screen review not done, and native dialogs not reviewed;
  - FR-063 bulk by filter or job;
  - phone and name duplicate rules.
- M4's P6 remains separate.
- **M5 stays unsigned.**

## J. Security fix F1, UI fixes U1–U9 and responsive review (2026-10-25)

Local work only, on `crm_test` (identity queried before every database run) with the **local fake** Storage API. The real bucket was not used. `crm_dev`, Neon and every managed database were not touched. No migration, RLS policy, grant or 20 MB limit was changed, and nothing was committed. The real-storage export flow (§I) was not repeated.

### J.1 F1: per-user file responses are never cached

**Fix.** One shared helper: `src/platform/http/private-response.ts`.
- `privateResponse()` builds every response of a per-user file route with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`. A caller cannot override either header.
- `privateRoute()` wraps the route handler. It forces those headers on whatever the handler returns, and turns an unexpected error into a generic, logged, private **500**. Before, an unexpected error was rethrown to the framework, whose error page carried no such header.
- **Applied to:**
  - `/app/leads/exports/[id]/download`;
  - `/app/leads/import/[id]/issues.csv`, which had the same defect (only its 200 was `no-store`).
- **Before the route runs:** the proxy's sign-in redirect for signed-out requests (`src/proxy.ts`) now sends `private, no-store`.
- **Framework-generated responses:** responses the framework produces itself on these two paths (for example another HTTP method) get the header from `next.config.ts` `headers()`.
- **Unchanged:** authorisation, status codes, messages, and the no-existence-leak 404 for other orgs.

**Statuses tested.**

| Path | Status | Real HTTP (built server, E2E) | Unit (route with mocks) |
|---|---|---|---|
| Successful download | 200 | ✓ `private, no-store` | ✓ |
| Already downloaded | 410 | ✓ | ✓ |
| Expired (past-window fixture) | 410 | ✓ | ✓ |
| Storage failure (object missing) | 503 | ✓ | ✓ |
| Missing export / malformed id | 404 | ✓ / ✓ | ✓ |
| Role without `lead.export` (Admin, Sales Executive) | 404 | ✓ | ✓ |
| Another org's Owner | 404 (not 410) | ✓ | ✓ |
| Signed out (proxy redirect) | 307 → `/login?next=…` | ✓ | ✓ (`src/proxy.test.ts`) |
| Session cookie that resolves to nobody | 401 | ✓ | ✓ |
| Another method (framework response) | — | ✓ header present | — |
| Unexpected error | 500, generic text | — (cannot be triggered safely over HTTP) | ✓ (logged, no detail) |
| Import problems CSV: missing / signed out / success / unexpected | 404 / 307 / 200 / 500 | 404, 307 ✓ | all ✓ |

**Shared-browser regression.**
- **HTTP (E2E):**
  - the Owner downloads (200) and tries again (410);
  - then the Admin of the same org and another org's Owner request the same URL;
  - each gets their own `404 "Not found"`, with `private, no-store`.
- **Real Chrome:** the exact §I.4 scenario was replayed on the fixed build.
  - The Owner's 200 and 410 were both `private, no-store`.
  - After sign-out, the Admin signed in to the **same browser** and fetched the same URL with normal caching. They got the server's **404 "Not found"**, not the Owner's cached 410.

### J.2 UI issues U1–U9

The shared components were fixed once, so every form and button benefits:
- **`ActionForm`:**
  - submits through a transition, so React no longer clears a form after a refused submission (inputs are cleared only after a success);
  - lists field errors by visible label (`fieldLabels`, else a humanised name; never the internal key) and marks the matching controls `aria-invalid`;
  - puts the message in a full-width (`col-span-full`) block, so grid columns cannot move;
  - refreshes the page after a `CONFLICT`.
- **`ActionFormButton`:**
  - starts fresh state when it becomes a different action;
  - wraps its message within the button's own width, so the button cannot move;
  - refreshes the page after a `CONFLICT`.
- **`Field`:** sets `aria-invalid` and `aria-describedby` on its control when it has an error.

| # | Fix | Regression test | Real-browser result (fixed build, desktop) |
|---|---|---|---|
| U1 | `ArchiveControl` (lead page) owns both actions and shows the message of the action that ran | E2E: archive returns ok; detail shows Restore | **Fixed.** After archiving: "Archived.", the Restore button, the banner; the button moved 0 px sideways |
| U2 | Conflict message plus refresh (`ArchiveControl`, `ActionForm`, `ActionFormButton`); message area of fixed position | E2E: stale archive returns `CONFLICT` "This lead is already archived" | **Fixed.** The stale tab shows "This lead is already archived. The page now shows the lead as it is." and refreshes to the archived, read-only view. The button stays at x = 988 |
| U3 | `CaseDecision` opens `/app/leads/review?conflict=<id>` after `CONFLICT`. The page shows "Someone else decided this case first (…). Your decision was not applied." with the case as resolved; `listDuplicateCases` accepts a scope-filtered `caseId`. `resolveCaseAction` now revalidates only after a recorded decision; before, the refreshed list removed the row before the client could react. **First browser attempt failed** for exactly that reason, and was fixed and re-verified | E2E: the notice for the loser; none for another org; none for a malformed id | **Fixed.** The stale tab's Restore shows the notice "(Kept archived, …)" and the resolved case |
| U4 | Labels in error lists; the merge page passes its field labels | Unit: `fieldErrorLines` / `humanizeFieldName` | **Fixed.** "Key: Use 2–40 …", "Name: Choose which value to keep"; the radios are `aria-invalid` |
| U5 | `MergePlan.localitiesAdded`; the localities row appears only when the duplicate adds localities, and the count includes it | Unit: merge plan (none / all already present / added); E2E: no row and count 1 without localities, row and count 2 with | **Fixed.** "Filled from the duplicate (1)": Alternate phone only |
| U6 | `ActionForm` and the new-lead form submit through a transition | Browser (no DOM test environment in the repo, see J.4) | **Fixed.** Custom-field form: label, key, type, options and required are all kept after a server error, and cleared after a success. New-lead: name, phone, city and intent are kept |
| U7 | Full-width message block | Browser | **Fixed.** Label and Key keep their left edges (225 / 768 at desktop; 33 / 33 at 390 px) when the message appears |
| U8 | Custom-field schema messages name the field: "<Label> is required", "<Label>: enter a number", and so on. The same strict rules apply: still refused, never coerced | Unit: every type; E2E: "E2E City is required", "E2E Size: enter a number", no "expected"/"received" | **Fixed.** "Site city is required" under the field; the field is `aria-invalid` and linked to the message; other values kept |
| U9 | `createLead` duplicate result gains `archived` (true only when the caller can see the lead). The form says the lead is archived and attaching sends the enquiry to review | Integration: archived → `archived: true`; out-of-scope caller → `leadId: null, archived: false`; E2E: `archived: true` | **Fixed.** "This phone number belongs to an archived lead…", "Open the archived lead" |

**Contract change (intentional, assertions still exact):** `CreateLeadResult` duplicate now includes `archived`. Three exact assertions in `leads.test.ts` and `assignment.test.ts` gained `archived: false`.

### J.3 Responsive review

The visible Chrome window (via the extension) could not be resized: it is maximised, `resize_window` has no effect, and a new window inherits that.

The responsive pass therefore used **the installed Chrome (headless, throwaway profile)** driven over the DevTools protocol. The viewport was set exactly with `Emulation.setDeviceMetricsOverride`: **390 × 900 (mobile), 768 × 900 and 1280 × 900**. Synthetic Owner session; local review server.

Routes: `/app/leads` (active and archived), `/app/leads/[id]` (an active and an archived lead), `/app/leads/review` (resolved cases), `/app/leads/merge`, `/app/settings/custom-fields`, `/app/leads/new`, `/app/leads/exports`. Screenshots: `…/scratchpad/responsive/<width>-<route>.png`, plus `report.json`.

| Check | Result |
|---|---|
| Horizontal page overflow | **None** on any route at any width (page `scrollWidth` ≤ viewport) |
| Clipped primary actions | **None** |
| Tables | The lead table (714 px at 390 and 768) is inside its own horizontal scroll container; the page does not scroll sideways |
| Unlabelled controls | **None** |
| Validation states at 390 px | Custom-field server error: values kept, the left edges of Label/Key/Type unchanged (33/33/33), message readable. New-lead required error: "Site city is required", `aria-invalid`, values kept |
| Confirmation at 390 px | Bulk archive: the button is fully visible; the browser dialog opened with "Archive 2 selected leads? They can be restored later." |
| Keyboard focus at 390 px | The first 12 Tab stops on every route all show a visible focus indicator |
| Readability (screenshots) | Merge conflict choices, review decisions and notices, export status ("Downloaded … 3 leads"), custom-field form and errors: readable; nothing cut off |

**Observations (not fixed; outside the nine issues):**
- **Navigation at 390 px:** the main navigation is a horizontal scroller (`overflow-x-auto`). Only Home–Organisation are visible, and Custom fields, Audit log, Notifications and the rest need a sideways swipe with no visual cue. This predates M5.
- **Lead page at 390 px:** the sidebar stacks below the main column, so Archive/Restore and Merge sit below the timeline.
- **Small targets:** inline text links (lead names, "Clear", "Refresh") are under 24 px tall. WCAG 2.2 exempts inline links, but rows of them are tight on a phone.
- **Not observed:** loading states other than the export's Preparing → Ready, because other actions finished too quickly.

### J.4 Tests run (actual)

| Suite | Result |
|---|---|
| Unit: `private-response.test.ts` (new), `proxy.test.ts` (new), `action-form.test.ts` (new), custom-field messages, merge plan | **15 + 2 + 7 + 2 + 2** new tests, pass |
| Full unit | **662/662** |
| Focused integration (`lead-archive-review`, `leads`, `assignment`, `custom-fields`, `lead-merge`) | **98/98** |
| E2E, full suite once after integration | 80 passed, 3 failed. All three were defects in the new tests, investigated before any change:<br>• fixture rows broke `export_job_retention` and the 5-a-day export quota (the rules were kept; the fixtures were moved to fresh orgs with a valid purge time);<br>• one wrong expected count (the duplicate's phone is a real fill) |
| E2E `m5-routes` after the fixes, and again after the U3 action change | **12/12**, **12/12**. The other 5 E2E files passed in the full run, so the suite totals **83/83** |
| Typecheck, ESLint, Prettier | clean |

There is no DOM test environment in the repository (no jsdom or Testing Library). Client-only behaviour (U1, U2, U6, U7, and the U3 navigation) is therefore verified in the real browser and recorded above, not by automated component tests. Adding one would be a new dev dependency and needs owner approval.

### J.5 Status

- **Fixed and verified:** F1 (headers on every status; shared-browser scenario in real Chrome) and U1–U9.
- **Remaining UI observations:** phone-width navigation affordance; the position of the lead-page actions at phone width; inline link target size. None blocks use; the owner should decide whether to address them in M5.
- **Separate open product requirements (unchanged):**
  - FR-063 bulk archive by filter and as a background job above 500 leads;
  - an owner decision on whether phone/name matches should create review cases (no rule invented);
  - M4 P6 (a real brokerage export).
- **Remaining acceptance gates for M5:**
  - owner review of this round (J.2/J.3);
  - FR-063 by filter/job, or an owner decision to defer it;
  - the phone/name rule decision.
- **M5 is not signed off.**

## K. Final M5 review actions (2026-10-26)

Local work only: `crm_test` (identity queried before every database run) and the local fake Storage API. Synthetic data only. The real bucket, Neon, managed databases and `crm_dev` were not accessed. No migration, RLS policy, grant, authorisation rule or 20 MB limit was changed, and nothing was committed.

### K.1 Owner decisions recorded

| Decision | Recorded in | Status |
|---|---|---|
| **FR-063:** keep the selection-based, all-or-nothing bulk archive of up to 100 leads. **Defer** archive by filter and background jobs above 500 leads until after the initial pilot | `docs/product/functional-requirements.md` FR-063 (status note), this section, `PHASE-2-PLAN.md` | **Partially implemented, explicitly deferred.** Built: bulk assign (M3), bulk archive of a selection (M5). Not built: archive by filter, jobs above 500, change team, add tag. The deferral is not a completed implementation |
| **Duplicate review:** keep exact-email detection; no review cases for phone-only or name-only matches; keep current phone matching and archived-lead review | `docs/product/lead-lifecycle.md` §5 rules 4 and 6, and the new §5.1 table of matching rules with rationale | Documented. No code change: the behaviour already matched (§H.2). The `PHONE_ALT` and `NAME_SIMILAR` reasons stay unused |

### K.2 Phone-width fixes

| Observation | Fix | Verified |
|---|---|---|
| The main navigation was a sideways scroller; most destinations were hidden at phone width | `src/components/main-nav.tsx`.<br>**Below 1024 px:** a **"Menu"** disclosure (`<details>`/`<summary>`, keyboard operable, names the current page: "Menu · Leads") lists every destination in full-width, 44 px tall links, and closes after navigation.<br>**At 1024 px and above:** a wrapping horizontal bar (no sideways scrolling).<br>`aria-current="page"` in both. Permission filtering is unchanged | **Unit** (static render): every link in the menu, 44 px classes, desktop bar without `overflow-x-auto`, `aria-current` on the current page, unread label.<br>**E2E:** the Owner's menu lists leads, custom fields and audit; a Sales Executive's has no settings link.<br>**Browser** (390/768): 10/10 destinations visible inside the opened menu, minimum height 44 px. At 1280: 10/10 visible in the bar.<br>**Keyboard** at 390: 4 Tabs reach "Menu" (visible focus); Enter opens it; Tab moves into it and reaches "Custom fields"; Enter navigates; the menu closes and the page is marked current |
| On a phone, Archive/Restore/Merge sat below the timeline | A **"Lead actions"** bar under the badges at every width: the Archive/Restore control (one instance, moved from the sidebar, with its explanation) and **"Merge a duplicate…"** (jumps to the merge form, `#merge`). Shown only to users who may archive or merge, as before | **E2E:** the bar comes before the Contact card, with Archive and Merge for an active lead and Restore without Merge for an archived lead; no bar for a Sales Executive.<br>**Browser:** the bar's top is above the Contact card at every width, e.g. 317 px vs 556 px at 390 for an active lead; 437 vs 620 for an archived one |
| Small inline tap targets | A `tap` utility in `globals.css`: at least 44 × 44 CSS px below 1024 px. Applied to inline links (lead names, Clear, Refresh, Change filters, review tabs, merge links, banners, "from a merged lead"), link-styled buttons, the brand and organisation links, the Filters toggle and every `Button` | **Browser:** at 390 and 768, **0** links, buttons or toggles under 44 × 44 px on all eight route views. The first run found 8 (the brand link, the five link-buttons above the list, "Preview merge", "Download (once)") and a second run found the Filters toggle; all were fixed and re-measured. At 1280 the desktop layout stays compact by design (mouse use) |

### K.3 Security regression

`src/modules/exports/download-route.test.ts` (new, route level) injects a failure through the route's own dependency (the export service), not an endpoint:
- **Unexpected `TypeError`** (message containing a fake password and an internal address):
  - status **500**, body exactly "Something went wrong. Try again later.";
  - `Cache-Control: private, no-store`, `nosniff`, `text/plain`, no `Content-Disposition`;
  - no message, type or stack text in the body;
  - logged once with the route label;
  - the route really ran with the signed-in context and id.
- **A non-Error throw:** the same 500.
- **Authorisation unchanged:** a refused role still gets the private, generic 404 and nothing is logged.

### K.4 Tests run (actual)

| Suite | Result |
|---|---|
| New unit: `download-route.test.ts` (3), `main-nav.test.ts` (4) | pass |
| Full unit | **669/669** |
| Full E2E once after the nav/layout change (it changes every page's markup) | **83/83** (6 files) |
| E2E `m5-routes` again after the last tap-target class changes | **12/12** |
| Responsive (installed Chrome, headless, exact 390/768/1280 viewports; the visible window cannot be resized) | 24/24 route-and-width checks pass. 0 small targets below 1024 px. Navigation fully reachable. Lead actions above the fold. No page overflow, clipping or unlabelled controls. Validation states keep their layout. The bulk confirmation fires. Every Tab stop shows focus; "body" entries are only Tab running past the last element on short pages. Screenshots in `…/scratchpad/responsive2/` |
| Typecheck, ESLint, Prettier | clean |

There is no DOM test environment in the repository, so client-only behaviour (menu closing on navigation, focus) is verified in the real Chromium engine as above.

### K.5 M5 acceptance status

| Gate | Status |
|---|---|
| Schema 0006 on `crm_test`, service layers, UI | Done (§F–§H) |
| Real-storage export acceptance (real bucket) | **Passed** (§I) |
| F1 cache headers on every download-route response | **Fixed and verified** (§J, K.3) |
| UI defects U1–U9 | **Fixed and verified** (§J) |
| Phone-width navigation, lead actions, tap targets | **Fixed and verified** (K.2) |
| FR-063 | **Partially implemented; by-filter and job above 500 explicitly deferred** by owner decision (not done) |
| Duplicate matching rules | **Decided and documented** (exact email only; phone and archived handling unchanged) |
| Migration 0006 on `crm_dev` / staging / production | **Not applied.** Needs separate approval when promotion is planned |
| Owner sign-off of M5 | **Pending.** All M5 acceptance actions requested so far have passed |

M5 is ready for the owner's sign-off decision. It is **not signed off** until the owner says so.

## L. Sign-off record (2026-10-26)

**Decision:** the owner approved M5 for its agreed scope on 2026-10-26.

**Evidence at sign-off** (actual results, §I–§K):

| Item | Result |
|---|---|
| Unit tests | 669/669 |
| Full E2E suite | 83/83 |
| Final M5 route suite (`m5-routes`) | 12/12 |
| Typecheck, lint, formatting | clean |
| Export-response caching fix (F1) | verified (every status `private, no-store`; shared-browser scenario in real Chrome; route-level 500 test) |
| UI issues U1–U9 | fixed and verified |
| Responsive layouts | reviewed at 390, 768 and 1280 px (headless installed Chrome; exact viewports) |
| Real-storage export acceptance | passed in the earlier approved run (§I, real private bucket, 2026-10-25) |

**Scope signed off:**
- FR-061 archive/restore;
- FR-062 merge by reference;
- FR-064 custom fields (≤ 30);
- FR-066 export jobs (Owner only, single use, 15 minutes, watermark, cleanup);
- the duplicate review queue with exact-email detection;
- **FR-063, partially:**
  - **implemented:** bulk assign (M3) and the all-or-nothing bulk archive of up to 100 selected leads (M5);
  - **deferred until after the pilot (owner decision):** archive by filter and background jobs above 500 leads;
  - **not implemented:** change team and add tag.

**Duplicate rules at sign-off:** exact email opens a review case; phone matching and archived-lead review are unchanged; phone-only and name-only matches create no cases (`docs/product/lead-lifecycle.md` §5.1).

**What this sign-off is not:**
- **Not M4 sign-off:** P6, a real anonymised brokerage export, is still open.
- **Not Phase 2 release acceptance:** P1, P2 and the M6 exit gates are open (see [PHASE-2-M6-READINESS.md](PHASE-2-M6-READINESS.md)).
- **Not a promotion:** migration 0006 is applied to local `crm_test` only. Applying it to `crm_dev`, staging or production needs separate approval.
- The documented limits remain:
  - note/enquiry redirection for merged leads is application-level only (§G.3);
  - the deactivation handover moves archived leads.
