# ADR-0009: Phase 3 first slice: lead follow-ups

- **Status:** Proposed. Implemented locally (uncommitted) on 2026-10-28; awaiting owner review.
- **Date:** 2026-10-28

## Context
The owner asked to start Phase 3 with one vertical slice: follow-up tracking and the next follow-up date of a lead. The approved requirements are FR-100 (task base), FR-102 (complete, cancel with reason, reschedule with a reason when rescheduled more than twice or when overdue) and FR-108 (at most one open "primary" follow-up per lead per assignee; `Lead.next_follow_up_at` is the earliest open follow-up, updated in the same transaction). The role matrix is user-personas-and-roles §4.3. FR-057, FR-060 and FR-065 stay deferred; calling, scripts, reminders, My Day and the timeline redesign are later slices. Migration: `0012_follow_ups`.

## Decisions

| # | Decision | Why | Alternative considered | Enforcement / evidence |
|---|---|---|---|---|
| 1 | **One `task` table** as in domain-model §2.6 (type, title, lead, assignee, due_at, priority, status OPEN/DONE/CANCELLED, completed_at, cancelled_at, cancel_reason, reschedule_count, version). This slice creates only `FOLLOW_UP`, which must link a lead | Avoids a second follow-up concept; later task types reuse the table | A dedicated `follow_up` table (rejected: duplicates Task) | `task_type`, `task_follow_up_lead` CHECKs |
| 2 | **FR-108 "primary" = at most one OPEN follow-up per (lead, assignee)**, a partial unique index. Every open follow-up is its assignee's primary one; a second is refused and the user reschedules the existing one | Satisfies "at most one primary" structurally; no Phase 3 requirement needs extra non-primary open follow-ups | An `is_primary` flag with several open follow-ups (more state, no current use) | `task_open_follow_up_uq`; integration test |
| 3 | **`lead.next_follow_up_at` is maintained by a database trigger** (`task_sync_next_follow_up`, SECURITY INVOKER, under RLS) and **only** by it: `lead_next_follow_up_guard` refuses any direct write (trigger depth < 2). It is the minimum `due_at` of the lead's OPEN follow-ups of any assignee. Changing it does not bump `lead.version` | Same-transaction consistency on every path (create, reschedule, close, merge) without relying on each caller; a derived value must not conflict with lead edits | Recompute in application code (a forgotten path would drift) | Integration: next date across three assignees through complete/reschedule/cancel; direct UPDATE refused (23514) |
| 4 | **Assignee = creator** in Phase 3 (`task.create` is OWN for every sales role); creating for others is FR-103 (Phase 4). The RESTRICTIVE insert policy also requires it | §4.3 "create for self"; FR-103 is Phase 4 | Allow Owner/Admin to assign now (scope creep) | Policy `actor_is_session_user`; test ignores a supplied assignee |
| 5 | **Scopes:** `task.read` / `task.update` O / O / T / S. TEAM = tasks on leads in the manager's team scope or assigned to them; OWN = assigned to them. Changing a follow-up also needs `lead.update` on a writable lead (not archived/merged). HR gets no task permissions until non-lead tasks exist | Follow-ups are lead work; archived leads are read-only (FR-061) | Task scope alone | Unit matrix; integration scope tests |
| 6 | **Closed is final.** `task_guard`: no change after DONE/CANCELLED, version must rise, reschedule count never falls, completion/cancellation time = transaction time, no reschedule into the past. Column grants exclude type, assignee, creator, creation time | FR-102 history must be trustworthy | Application checks only | DB tests as crm_app |
| 7 | **Scheduling refused on Won/Lost leads** ("Reopen it first") | A closed lead should not show a next follow-up | Allow (would surface closed leads as due) | Integration test |
| 8 | **Merge moves open follow-ups** to the survivor; where the survivor already has one for the same assignee, the merged lead's is cancelled with a recorded reason. Closed ones stay on the tombstone as history. Plain SQL in `merge.ts` (tasks depends on leads, not the reverse) | FR-062 "tasks moved"; a merged lead can no longer change (`lead_hygiene_guard`) | Leave them on the tombstone (stale next date) | Integration test; audit `followUpsMoved/Cancelled` |
| 9 | **Times:** entered as `YYYY-MM-DDTHH:MM` in the org's time zone (`parseOrgLocal`), stored as timestamptz; shown with the app's existing IST formatter. Must be in the future (1 min slack) and within 730 days | Existing conventions (date filters, visit time) | — | Unit + integration validation tests |
| 10 | **Reschedule reasons** are kept in the lead timeline (`lead_activity` type `TASK`) and the audit log, not in a task column | Append-only history already exists | A `last_reschedule_reason` column (loses earlier reasons) | Activity/audit assertions |

## Known gaps (not in this slice)
- Lead reassignment and user deactivation do not yet hand over open follow-ups (FR-077 handover covers leads only).
- Stage change to Won/Lost does not close open follow-ups.
- FR-056 "follow-up due" list filter, My Day (FR-101), reminders (FR-106), escalations (FR-076).
- **Update 2026-10-29:** the other FR-100 task types (Call, Meeting, Document, Other; optional lead) are built: [ADR-0015](ADR-0015-task-types.md), migration 0020.
