# Phase 2 M6: set-based import commit (design)

> **Status (2026-10-26):** **the default import commit since the M6 local acceptance** (load-test plan §11–§12). It passed:
> - the corpus at 250k leads, 1,587–1,896 rows/s;
> - the built-app E2E with both strategies;
> - the differential, concurrency and crash tests.
>
> **Rollback:** set `IMPORT_COMMIT_STRATEGY=row` in the worker environment and restart it.
>
> Nothing here needs a migration, function, table, grant or policy change.
>
> Measured results are in [PHASE-2-M6-LOAD-TEST-PLAN.md](PHASE-2-M6-LOAD-TEST-PLAN.md) §8.

## 1. Problem

**Requirement (NFR-006):** ≥ 300 rows/s per worker, so a 200-row batch (`limits.batchRows`) must commit in ≤ 0.67 s.

**Where the current path stands (§7.6 of the load-test plan):**
- With P-A, P-B and P-F the database work per row is ≈ 2.7 ms, but each created row still costs ≈ 10 sequential statements.
- A statement costs ≈ 2.8–3.4 ms through Prisma's interactive transaction on the laptop, more over a network.
- On top of that, `lockPhones` issues one statement per phone (≈ 220 per batch), and every created row runs its own e-mail lock and lookup.

So a 200-row batch is ≈ 2,300 round trips: ≈ 7 s at 3 ms each. **No index can fix this.** The number of statements per batch has to stop growing with the number of rows.

## 2. Goal and non-goals

**Goal:** a batch commits in a **constant number of statements** (≈ 20–25, independent of the row count), with exactly the outcomes and rows the row-by-row path produces.

**Not changed:**
- validation, mapping, the job state machine;
- batch size and transaction boundaries (one transaction per batch, progress atomic with the leads);
- any rule in lead-lifecycle §5;
- RLS, grants, policies, schema;
- the manual-create path.

## 3. Algorithm (one batch, one transaction, as `crm_app` with the tenant context)

Notation: R = the batch's rows in file order; C ⊆ R = rows that will create a lead.

| # | Statement (each one round trip, whatever |R|) | Replaces (per batch of 200) |
|---|---|---|
| 0 | Job row `FOR UPDATE`, reported rows, active sources (processor, unchanged) | — |
| 1 | Assigner setup (unchanged: target or round-robin state) | — |
| 2 | **Phone locks:** `SELECT count(pg_advisory_xact_lock(hashtextextended(k, 0))) FROM unnest($keys) WITH ORDINALITY …` in the **same sorted key order** as `lockPhones` | ≈ 220 statements |
| 3 | **E-mail locks:** the same, for the normalised e-mails of R, sorted, after the phones | up to 200 (one per created row) |
| 4 | **Done check (idempotency):** enquiries with `channel_ref = 'IMPORT'` and `external_id = ANY($ids)` | 200 |
| 5 | **Open matches:** one LATERAL query, per phone, the oldest open lead holding it as primary or alternate (the P-F predicate, served by `lead_open_phone_uq` and the alternate-phone index) | 200 |
| 6 | **Custom-field definitions** `FOR SHARE` (unchanged; once per batch already) | — |
| 7 | **Returning customers:** one query, per primary phone of C, the newest live WON/LOST lead with that primary (the P-A predicate with `phone_last10 = ANY`) | 200 |
| 8 | **Insert leads:** one `INSERT … SELECT FROM unnest(…) RETURNING id, primary_phone_e164` | 200 |
| 9 | **E-mail candidates:** one query, per normalised e-mail, the 10 oldest live leads other than this batch's new ones (P-B index) | 200 |
| 10 | **Duplicate cases:** one `INSERT … SELECT FROM unnest(…) ON CONFLICT DO NOTHING` (the 0006 guard trigger still runs per row) | ≤ 200 |
| 11 | **Enquiries:** one multi-row insert (first enquiries of C plus attached enquiries) `RETURNING id, external_id` | 200 |
| 12 | **Stage history:** one multi-row insert | 200 |
| 13 | **Assignment spells:** one multi-row insert (rows with an owner or team) | ≤ 200 |
| 14 | **Notes:** one multi-row insert (rows with a note) | ≤ 200 |
| 15 | **Activities:** one multi-row insert (CREATED, ENQUIRY and NOTE) | 200–400 |
| 16 | **Outbox:** one multi-row insert of `lead.enquiry_returned` for attached rows | ≤ 200 |
| 17 | Archived-lead routing (D2), per attached archived lead (rare; unchanged code) | — |
| 18 | Round-robin save and the assignment digest (unchanged; per assignee, not per row) | — |
| 19 | Row results and job progress (processor, unchanged; results already chunked) | — |

**In memory, between 5 and 8, row by row in file order (no database calls):**
- **Already imported:** a row whose external id was found in step 4 becomes ALREADY_IMPORTED.
- **Open match:** the row's match is the oldest of
  - the step 5 matches for its phones, and
  - the leads created **earlier in this batch** that share a phone with it.

  Batch leads all carry the transaction time; existing leads are compared by their `created_at`, exactly as `ORDER BY created_at` does.
- **Policy:** with a match, the row is SKIPPED_DUPLICATE (SKIP) or ATTACHED (ATTACH).
- **Custom fields:** otherwise `checkCustomValues` runs (pure code). On failure the row is FAILED with the same field and code.
- **Create:** otherwise `assigner.next()` gives the target, and the row joins C, so its phones become matches for later rows of the batch.

**Mapping back:**
- Created leads map to their rows by **primary phone**, which is unique among C: two rows of C cannot share a phone, because the second would have matched the first.
- Enquiries map by **external id** (`<importId>:<row>`), unique per row.
- The batch fails, and rolls back as a whole, if any mapping is not one-to-one. This "cannot happen" check exists so a wrong mapping is never written.

## 4. Requirements, and how each is met

| Requirement | How |
|---|---|
| **Bulk duplicate checks** | Steps 4, 5, 7 and 9: one query each for the batch instead of one per row |
| **Returning customer, normalised e-mail** | Step 7 uses the P-A predicate; step 9 the P-B column and index. Same rules: primary only for returning customers; case-insensitive exact e-mail; NULL and blank never match; deleted and merged excluded; at most 10 cases per lead |
| **Batched validation and writes** | Validation is already per file (unchanged). Writes are steps 8 and 10–16 |
| **Required custom fields, stable codes** | Same `lockedDefinitions` and `checkCustomValues` with `requireRequired`, same CUSTOM_FIELD_REQUIRED / CUSTOM_FIELD_INVALID mapping, nothing written for a failed row |
| **Phone and e-mail duplicate semantics** | Same predicates as `findOpenMatch`, the returning lookup and `detectEmailDuplicates`. Matches with leads created earlier in the same batch are resolved in memory, in file order |
| **Deterministic locking** | Phone keys sorted exactly as `lockPhones` (manual create uses the same order), then e-mail keys sorted. Every locker takes phones before e-mails, in one global order, so concurrent imports and manual creates cannot deadlock. **Improvement:** today each row takes its e-mail lock in file order, after its insert, so two imports with the same e-mails in different orders can deadlock (one is aborted and retried) |
| **Per-row idempotency, crash and resume** | Unchanged mechanism: the external id on the row's enquiry (`lead_enquiry_external_uq`) and the step 4 check. A crash anywhere rolls back the whole batch with the job cursor, so a resume repeats the batch from scratch |
| **All-or-nothing per batch, transactional progress** | Unchanged: the processor's single transaction (job lock, leads, results, cursor) |
| **Tenant isolation under RLS** | Every statement runs as `crm_app` inside `withTenant`: RLS on every table, the RESTRICTIVE insert policies (`created_by`, `actor_id`, `changed_by`, `assigned_by` = `app.user_id`; `occurred_at` and `started_at` = `now()`) check every inserted row. No `SECURITY DEFINER`, no LEAKPROOF marking, no policy or grant change. Phone and e-mail predicates are plain text equality (LEAKPROOF), so indexes serve them under RLS |
| **Input row → result → error mapping** | Each outcome carries the row number. Leads map by primary phone and enquiries by external id. Mismatches abort the batch (above) |
| **Memory for 100k rows** | The commit itself holds one batch (200 rows). The 100k memory peak (781 MB RSS in §7.7) comes from the processor keeping the whole parsed file and its plan. §6 has the measurements and the proposal |

## 5. What stays per row, and why

| Step | Why it stays per row |
|---|---|
| Archived-lead routing (D2) | Only for an attached **archived** lead, so rare. Its code and review-case rules stay as reviewed |
| Assignment digest | Per assignee, not per row: 1–40 statements per batch at most |

## 6. Memory (100,000 rows)

**Current processor:**
- It loads the file once per worker run and keeps `parsed.rows` (all cells) and `plan` (a `PreparedLead` per row) for the whole run.
- On the laptop that was 781 MB RSS for the 100k corpus file (load-test plan §7.7).

**Proposal:** a separate change, not prototyped here.
- After planning, keep the compact plan only: drop `parsed.rows` and the raw cells.
- Alternatively, plan each batch on demand from the parsed file. The plan is deterministic, so a resume reproduces it; the `FILE_CHANGED` check stays.
- Either way, measure peak RSS on the 100k file before and after.

## 7. Risks and how they are contained

| Risk | Containment |
|---|---|
| A subtle difference from the row path | A differential test runs identical batches through both strategies on twin organisations and compares every outcome and every written row (§8 of the load-test plan) |
| A very large statement | ≤ 200 rows × ≈ 35 parameters as arrays (one parameter per column), not 7,000 bind parameters |
| Batch statement fails mid-way | The transaction rolls back (as today); the job cursor is unchanged |
| Lock-ordering mistake | The keys and order are computed by the same function as `lockPhones` and tested against it |

## 8. Rollout (after review)

1. Approve the design.
2. The worker selects the strategy with `IMPORT_COMMIT_STRATEGY` (`src/env.ts`: `row` default, or `set`; anything else refuses to start).
   - The built-app acceptance runs with `E2E_IMPORT_COMMIT_STRATEGY=set` (load-test plan §10).
   - The default changes to `set` only after the corpus and E2E acceptance pass. `IMPORT_COMMIT_STRATEGY=row` then stays as the rollback switch.
   - No migration is involved.
3. Re-measure NFR-006 on staging. Network latency is the main unknown, and a constant number of statements per batch is the point of the design.
