# ADR-0020: Recurring tasks (FR-107)

- **Status:** Accepted by the owner on 2026-10-30 for local engineering completion (focused post-fix tests and browser checks). Implemented locally (uncommitted).
- **Date:** 2026-10-30
- **Builds on:** [ADR-0015](ADR-0015-task-types.md)–[ADR-0019](ADR-0019-task-reminders.md). Migration `0024_task_series`.

## Context
FR-107 (Phase 4, Could): "Recurring tasks (daily/weekly) for non-lead tasks." Actor SM. The owner approved the product rules on 2026-10-30. This ADR records how they are built.

## Decisions

| # | Decision | Source | Evidence |
|---|---|---|---|
| 1 | **Model:** `task_series` holds the template: type, title, priority, frequency, weekday, org-local time, inclusive end date, meeting length, location and attendees. Each occurrence is an ordinary `task` with `series_id`. No other scheduling model exists. | Rule 9 | Migration 0024 |
| 2 | **Scope:** no-lead Call, Meeting, Document and Other tasks only, never follow-ups. The database refuses an occurrence with a lead or of type Follow-up. | Rule 1 | `task_series_no_lead`, `task_series_type` |
| 3 | **Who:** a new permission `task.recur` (Owner, Admin, Sales Manager; own series only). A series' tasks are assigned to its creator, never to others. The RLS insert policy also requires the creator to be the owner and one of those roles. Occurrences keep no-lead privacy (ADR-0016 D2): the owner, plus Owner/Admin through ORG task scope. | Rule 2 | `permissions.ts`; integration; DB 42501 |
| 4 | **Schedule:** DAILY at an org-local HH:MM, or WEEKLY on one weekday (Monday = 0) at that time. Times follow the org time zone, including daylight saving (the zone's own offset at that wall-clock time). | Rule 3 | `series-rules.ts` + unit tests (India; Europe/London DST) |
| 5 | **Advancing:** completing or cancelling an occurrence creates the next one **in the same transaction**. The next date is the first strictly after both **now** and the closed occurrence's own due time. Missed dates are skipped (no backlog), and an occurrence closed early does not come back on the same date. | Rules 4, 5 | `advanceSeries`; integration (skip, early completion) |
| 6 | **Exactly one open occurrence:** the series row is locked, an existing open occurrence stops the advance, and `task_series_open_uq` allows only one open task per series. Concurrent completions are serialised by the task row lock and version, so exactly one next occurrence is created. | "transactional and idempotent" | Integration (three concurrent closes → one next) |
| 7 | **End date:** optional and inclusive (org-local day). A series whose remaining dates all fall after its end date creates nothing more. Creating one with no date left is refused. | Rule 6 | Unit + integration |
| 8 | **Cancel vs stop:** cancelling an occurrence (with a reason, FR-102) skips that date and the series continues. **Stop series** prevents further occurrences and leaves the open task as it is. A stopped series cannot be edited or restarted. | Rules 7, 8 | `task_series_guard`; integration |
| 9 | **Edit:** title, priority, frequency, weekday, time, end date, and the meeting length, location and attendees can be changed (optimistic version). This changes **future** occurrences only; the open task keeps its values. The type is fixed. | Rule 8 | Integration |
| 10 | **Meetings:** each occurrence gets end = start + length, the location, and the attendees still active then (inactive ones are left out). Invitations and notifications follow ADR-0017 per occurrence. The overlap warning shows on creation and on completion or cancellation when the next occurrence overlaps. | Rule 10 | Integration |
| 11 | **Reminders:** each occurrence is a task, so it gets its own FR-106 reminder (own key, delivery-time checks). | Rule 9 | Integration |
| 12 | **Deactivation:** deactivating the owner stops their series. Their open no-lead occurrence is cancelled by the existing rule (ADR-0015), which creates nothing new. | Rule 11 (no orphan series) | Integration |
| 13 | **History:** occurrences write the usual `task.*` audit entries (with `seriesId`); a series writes `task_series.created/updated/stopped`. There is no lead timeline (no-lead tasks). An occurrence created when someone else (an Owner) completed the previous one is not shown as "Assigned by". | Rule 11 | Integration |
| 14 | **UI:** My Day has a "Repeating tasks" card for `task.recur` roles. It lists active series ("Daily at 09:00, until …", current occurrence) with **Edit series…** and **Stop series…** (in-page confirmation), and a collapsible **Add a repeating task** form. Occurrences carry a "Repeats" badge on My Day. | Mobile-first | Unit render test; browser check |

## Verification notes (2026-10-30)
- The browser check found a defect the unit and integration tests could not: the dev bundler (Turbopack) left an imported function called in a for-loop update clause unresolved (`addDays is not defined` in `nextOccurrence`), so creating a series failed in the app. The loop was rewritten to advance inside its body. Vitest compiles the code differently, which is why tests passed.
- Stopping a series does not re-render My Day: the item stays with a "Stopped" badge and its confirmation, and leaves the list on the next visit.

## Known limitations
- Recurrence only for one's own no-lead tasks (by rule). There are no monthly or custom rules, and no restarting of a stopped series (create a new one).
- With no completion or cancellation, no new occurrence appears: an open occurrence simply becomes overdue, as any task does.
- A series stopped by deactivation stays stopped if the member is reactivated.
- Series attendee ids are kept as an array and checked when each occurrence is created, rather than enforced by a foreign key.
