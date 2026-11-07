# ADR-0018: Calendar views (FR-105)

- **Status:** Accepted by the owner on 2026-10-30 (FR-105 closed on its focused tests and browser checks). Implemented locally (uncommitted).
- **Date:** 2026-10-30
- **Builds on:** [ADR-0015](ADR-0015-task-types.md), [ADR-0016](ADR-0016-task-assignment.md), [ADR-0017](ADR-0017-meeting-details.md). No migration.

## Context
FR-105 (Phase 4, Should): "Day/week/month calendar views." Actors: All. No acceptance criteria. The roadmap lists "meetings + calendar views" in Phase 4. Nothing else specifies whose items a calendar shows, so this slice builds the unambiguous part, **a personal calendar**, with exactly the visibility of My Day. Team calendars are out of scope (owner decision below).

## Decisions

| # | Decision | Source / why | Evidence |
|---|---|---|---|
| 1 | **Same data, no new model:** the calendar reads the `task` table and `task_attendee` (ADR-0017). No migration, no copy of schedule data. | Domain model ("avoids two calendars") | `tasks.calendar` |
| 2 | **What appears:** the caller's own **OPEN** tasks of every type, and **OPEN** meetings they are currently invited to (read-only, "Invited", organiser named). Completed and cancelled tasks, removed invitations and other people's tasks never appear. Reassignment and Won/Lost act through the task lifecycle, so moved or cancelled tasks leave the calendar. | My Day visibility (ADR-0015/0016/0017); "users' own tasks are always visible" | Integration `calendar.test.ts` |
| 3 | **No wider visibility:** a manager's, Admin's or Owner's calendar is their own, even though their task scope is wider. No-lead tasks stay private (ADR-0016 D2). An invitation never shows the lead unless the attendee can already open it. | Owner decisions; FR-105 does not grant more | Integration |
| 4 | **Days are org-local** (the org time zone, as for My Day and FR-056). Times are shown in India time like the rest of the app. A day is [00:00, next 00:00). A meeting that started the day before and is still running at the first day's start is listed on the first day. | Existing time conventions | Unit (`calendar-rules.test.ts`) + integration boundaries |
| 5 | **Periods:** Day; Week (**Monday first**, ISO 8601, as used in India); Month (whole weeks around the month, other-month days dimmed). Previous / Today / Next step by one day, one week, or one month (the 31st becomes the last day of a shorter month). An invalid view or date falls back to this week. URL: `/app/calendar?view=…&date=YYYY-MM-DD`. | FR-105; week start not specified, ISO chosen | Unit |
| 6 | **Layout:** the week is seven stacked day cards on phones and seven columns on wide screens. The month grid shows a count per day on phones and the first three items ("+N more") on wider screens. Every day links to its day view. | NFR mobile-first | Browser check at 390×844 and 1440×900 |
| 7 | **Overlaps:** meetings that overlap another of the caller's meetings shown (FR-104 rule, back to back is not an overlap) carry an "Overlaps" badge. | FR-104 | Integration |
| 8 | **Read-only:** the calendar changes nothing. Tasks are completed, rescheduled or edited on My Day or the lead page. No reminders (FR-106) or recurrence (FR-107). | Scope | — |
| 9 | **Limit:** at most 1,000 items per period (earliest first, with a notice). | Bounded reads | — |

## Owner decisions (2026-10-30, on acceptance)
1. **FR-105 stays a personal calendar:** a user sees their own open tasks and the meetings they are invited to. Other people's calendars are not part of FR-105. A future team-calendar feature must keep role-scoped access to lead-linked tasks and must not show a Manager another person's private no-lead tasks because the Manager assigned them.
2. **No closed tasks:** completed and cancelled tasks stay out of the calendar, on past dates too. A historical task/activity view is a separate feature.

## Known limitations
- No drag-and-drop or editing from the calendar; no time-grid layout (items are listed by time within each day).
- A meeting crossing midnight inside the period is listed on its start day only.
