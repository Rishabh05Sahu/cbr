# ADR-0017: Meeting details (FR-104)

- **Status:** Implemented locally (uncommitted) on 2026-10-30. Verification closed 2026-10-30: focused tests pass, and the browser checks at 390×844 and 1440×900 pass. The overlap warning is confirmed by a focused rerun; the earlier failed assertion was a check timing error, not a product defect. Awaiting owner review.
- **Date:** 2026-10-30
- **Builds on:** [ADR-0015](ADR-0015-task-types.md) (Meeting = start time only until now), [ADR-0016](ADR-0016-task-assignment.md). Migration `0022_meeting_details`.

## Context
FR-104 (Phase 4, Should): "Meetings: start/end, location or link, attendees (internal), linked lead." Acceptance: "Overlap warning for same user". Domain model §2.6: meetings are tasks of type `MEETING` with `end_at`, `location` and attendees (`TaskAttendee`). The linked lead already exists (optional, ADR-0015).

The owner decided four unspecified points on 2026-10-30:
- **Visibility:** attendees see the meeting read-only on their My Day.
- **Who may be invited:** any active member of the org.
- **Notification:** attendees get an in-app notification.
- **End time:** required.

## Decisions

| # | Decision | Source / why | Enforcement / evidence |
|---|---|---|---|
| 1 | **End time** is required for a new meeting and whenever a meeting's details are edited. It must be after the start and at most 24 hours later. Meetings saved before 0022 keep no end until edited. | FR-104 "start/end"; owner decision | `meetingEndProblem`; `task_end_after_start`; unit + integration |
| 2 | **Location or link:** one optional plain-text field (at most 300 characters). It is shown as text and never rendered as a clickable link. The history and audit record only that it changed, because it may be an address. | FR-104 "location or link"; domain model `location?` | `task_location`; integration (audit has no address) |
| 3 | **Meeting fields only on meetings.** The database refuses an end or a location on any other type. The application refuses them, with field errors, on Call, Document, Other and Follow-up, which need none of them. | Keep other types unchanged | `task_meeting_fields`; `refuseMeetingFields`; integration |
| 4 | **Attendees (internal):** `task_attendee` rows. They are any ACTIVE members of the same org except the meeting's assignee, at most 30, any role. An invitation gives **no lead access**. A removal is recorded (`removed_at`/`removed_by`) and never deleted, and a person can be re-invited. | FR-104 "internal"; owner decision | DB trigger `task_attendee_guard`, RLS (tenant, actor = session user), no DELETE grant; integration |
| 5 | **Attendees' view:** open meetings they are invited to appear on their My Day, read-only ("Invited", "Meeting of …"), until the meeting ends. The lead is shown only if they can already open it. They cannot change the meeting, and their other task visibility is unchanged. | Owner decision; ADR-0016 D2 (no-lead privacy otherwise unchanged) | `myDay`; integration |
| 6 | **Notification:** one in-app `MEETING_INVITED` per meeting and invitee (outbox `meeting.invited`, worker). It is skipped if the person was removed, the meeting is no longer open, or the person is inactive. The link is My Day, never the lead. | Owner decision | Migration 0022; `notifications.build`; integration |
| 7 | **Overlap warning (same user):** creating, editing or rescheduling a meeting checks the assignee's other open meetings, as assignee or current attendee, using half-open [start, end) intervals. A start-only meeting counts as its minute. It is a **warning only**: the save goes ahead. Titles are named only to the person themself; anyone else gets a count, so no-lead meetings stay private. | FR-104 acceptance; ADR-0016 D2 | `overlapWarning`, `meetingsOverlap`; unit + integration |
| 8 | **Editing:** `updateMeeting` changes end, location and attendees with an optimistic version check. It needs the same rights as rescheduling (task.update scope, plus lead.update on a writable lead). Attendees, a manager on someone's no-lead meeting and other orgs get "not found". The start is changed by Reschedule (FR-102 reasons), and the **end moves with it** so the length is kept. | FR-102 and ADR-0015/0016 rules unchanged | Integration |
| 9 | **Unchanged:** assignment (FR-103), DNC (a meeting on a DNC lead is allowed and a Call task is not), Won/Lost (cancels the meeting, which then leaves attendees' My Day), handover, deactivation and merge. | — | Integration regression suites |

## Known limitations
- Calendar views are FR-105 ([ADR-0018](ADR-0018-calendar-views.md)). No reminders (FR-106) or recurring meetings (FR-107).
- Attendees are not told when they are removed or when a meeting is cancelled or moved, and they have no "accept/decline".
- An attendee who is deactivated keeps their (inactive) invitation rows. They are no longer notified.
- The "who can be invited" list is capped at 200 names.
- Overlap checks consider meetings only. Site visits (Phase 4) are not included yet.
