# ADR-0019: Task reminders (FR-106)

- **Status:** Accepted by the owner for the current release on 2026-10-30 (focused tests and browser check). Implemented locally (uncommitted). Configurable offsets are **not** complete (deferred, below).
- **Date:** 2026-10-30
- **Builds on:** [ADR-0005](ADR-0005-background-processing.md), [ADR-0015](ADR-0015-task-types.md)–[ADR-0018](ADR-0018-calendar-views.md). Migration `0023_task_reminders`.

## Context
FR-106 (Phase 4, Must): "Reminders at configurable offsets (default 15 min before) via in-app and push/email." Acceptance: "Exactly one reminder per task per offset (idempotent job key)".

Supporting sources:
- **Workflow C:** "Reminder notification to assignee". A reschedule changes `due_at`, and because the key includes `due_at`, a stale job "finds the task changed and exits".
- **NFR-007:** delivered within 60 s of the scheduled time (p95).
- **Domain model:** `TaskReminder (task_id, offset_minutes, fire_at)`, unique, is "the idempotency anchor".
- **system-architecture §5:** key `rem:{taskId}:{offset}:{dueAtEpoch}`, recheck of task state, backfill sweep from Postgres.

The owner asked for reminders inside the application only, with no external providers.

## Decisions

| # | Decision | Source / why | Evidence |
|---|---|---|---|
| 1 | **One offset: 15 minutes before the due time**, for every open task type (follow-ups, calls, meetings, documents, other). | FR-106 default | `REMINDER_OFFSET_MINUTES`; integration |
| 2 | **Idempotency anchor:** `task_reminder`, unique `(task_id, offset_minutes, fire_at)` with `fire_at = due_at − offset`. A reminder is recorded at most once per key, whatever the number of claims, concurrent workers or retries. Its notification is unique per (event, recipient). | FR-106 acceptance; domain model | DB unique index + CHECK; integration (concurrent claims, redelivery) |
| 3 | **Postgres is the scheduler:** the worker calls `app.task_reminders_claim()` every **30 s** (NFR-007 ≤ 60 s). In **one statement** it records the due reminders and writes an outbox event `task.reminder_due` for each one recorded. The existing relay and notification worker deliver it. This polls the source of truth directly instead of using per-task delayed BullMQ jobs plus a 5-minute backfill: same guarantees, one mechanism, nothing lost if Valkey is flushed. | ADR-0005 ("Postgres the source of truth"); fewer moving parts | `reminders.ts`, worker `reminderLoop`; deviation from system-architecture §5 noted here |
| 4 | **When a reminder is due:** an OPEN task whose `due_at` is in (now, now + 15 min]. A task created or rescheduled less than 15 minutes ahead is reminded at once. A task already past due is never reminded: it shows as overdue on My Day instead. | NFR-007; no reminder after the fact | Integration (window boundaries) |
| 5 | **Delivery re-checks the task** (system-architecture §5): still OPEN, still due at the reminder's `due_at`, not yet due, and assignee active. Otherwise nothing is sent. | Workflow C (stale key) | Integration (complete/cancel/reschedule before delivery, late event, suspended assignee) |
| 6 | **Reschedule:** the old reminder becomes stale and is never delivered. The new due time has its own key, so it gets its own reminder when it comes within 15 minutes. | Workflow C | Integration |
| 7 | **Recipient:** the task's **current** assignee at delivery (after a lead reassignment or deactivation handover, the new one). It is in-app only: `TASK_REMINDER`, "Reminder: call at 10:30 am", the task's type and title, and a link to the lead page or My Day. The time is in the org time zone. No lead details are in the text. | Workflow C "to assignee"; owner: internal only | `notifications.build`; integration |
| 8 | **Lifecycle:** completed and cancelled tasks are never claimed. Won/Lost cancels a lead's tasks first, so they are not claimed either. | ADR-0010/0015 | Integration |
| 9 | **Security:** `task_reminder` is RLS-isolated; `crm_app` may only read its own org's rows. Writes happen only through the SECURITY DEFINER claim, owned by `crm_definer`. That role gets a SELECT policy on open tasks (four columns), insert on `task_reminder`, and insert on `outbox_event` (pattern of 0002/0019). | ADR-0004 | Integration (42501 for direct insert; other org sees no rows); db-roles suite |

## Owner decisions (2026-10-30, on acceptance)
- **Offset:** fixed at 15 minutes in this release. **Configurable offsets are deferred** and must not be reported as done. Who configures them (organisation, user or task) is still to be decided.
- **Attendees:** meeting attendees get the meeting invitation (ADR-0017) but **no** separate FR-106 due-time reminder.
- **Reassignment:** a task already reminded for a given due time does **not** get another reminder because it was reassigned afterwards.

## Still open
- **Push/email channels** are FR-119 (preferences, quiet hours). They are not built here, by owner instruction.

## Known limitations
- A reminder's notification stays in the notification centre after the task is completed (notifications are not retracted).
- Delivery timing depends on the worker running; with the worker down, reminders whose due time passes in the meantime are not sent (decision 4).
