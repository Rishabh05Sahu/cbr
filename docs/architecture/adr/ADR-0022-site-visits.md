# ADR-0022: Basic site visits (FR-150, FR-151, FR-152)

- **Status:** Implemented locally (uncommitted) on 2026-10-30. The owner's closing decisions (below) are implemented; their focused regression tests (site-visits integration 19/19; calendar, My Day and database-roles 74/74; unit 1,029/1,029) and browser checks at 390×844 and 1440×900 passed on 2026-10-30. The full integration suite was **not** rerun after these corrections (last full run, before them: 47/47 files, 736 tests).
- **Date:** 2026-10-30
- **Builds on:** [ADR-0010](ADR-0010-follow-up-lifecycle.md), [ADR-0016](ADR-0016-task-assignment.md), [ADR-0019](ADR-0019-task-reminders.md). Migrations `0026_site_visits` and `0027_site_visit_dnc_guard`. OD-01 (accepted): basic visits in Phase 4, property links in Phase 5 (FR-157).

## Context
Sources:
- **FR-150:** "Schedule a basic site visit: lead, date/time, location/meeting point (free text), assigned salesperson." Acceptance: the lead stage is auto-updated to Site Visit Scheduled in the same transaction, and reminders are created for the assignee.
- **FR-151:** statuses Scheduled, Confirmed, Rescheduled (same record, reason + new time, reschedule count), Cancelled, Attended, No-show; reasons for cancel and no-show; invalid transitions rejected server-side.
- **FR-152:** visit-level outcome: attended/no-show, interest level, objections, notes, next action. Acceptance: next action required on Attended; lead stage → Site Visit Completed.
- **Lead lifecycle:** "visit cancelled (no new visit)" → Qualified; automatic changes are recorded with the related entity.
- **Workflow D:** reminders "for the exec and assignee"; "double-booking an assignee → warning".
- **Role matrix §4.3:** `site_visit.manage` O/O/T/S; `site_visit.read` O/O/T/S + assigned visits.

## Decisions

| # | Decision | Source | Evidence |
|---|---|---|---|
| 1 | **Own entity:** `site_visit` (lead, assigned user, scheduled by, time, meeting point, status, reschedule count, reasons, outcome, version), with an append-only `site_visit_event` history. Not a task or meeting. FR-157 can add `site_visit_property` rows later; a basic visit has none. | Domain model §2.7; OD-01 | Migration 0026 |
| 2 | **Scheduling:** needs `site_visit.manage` over the lead (its lead scope), a writable lead (not archived or merged), not Won/Lost, a time in the future (within two years, org time zone), and a meeting point (≤ 300 characters). | FR-150 | Integration; DB `site_visit_lead_open_guard` |
| 3 | **Stage on scheduling:** an automatic change (SYSTEM_RULE, linked to the visit) to Site Visit Scheduled from New, Assigned, Contacted, Qualified or Site Visit Completed, using the existing lifecycle rules. From before Qualified this needs the qualification fields, and otherwise nothing is saved. From Negotiation or Nurture the stage is **left unchanged** (the lifecycle has no such path). | FR-150; lead-lifecycle §2 | Integration |
| 4 | **Assignee:** the scheduler by default. Anyone else follows the scheduler's own `site_visit.manage` scope, the same rule as tasks for others (FR-103): Executive only themselves, Manager members of led teams, Owner/Admin any active sales member or administrator. | Not specified; consistent with ADR-0016 | Integration |
| 5 | **Transitions (FR-151):** an open visit (Scheduled, Confirmed, Rescheduled) may be confirmed (unless already confirmed), rescheduled (new time + reason; same record, count + 1), cancelled (reason), or closed as No-show (reason) or Attended. Cancelled, Attended and No-show are final. Optimistic version. The database enforces the same (`site_visit_guard`, state CHECK). | FR-151 | Unit + integration + DB tests |
| 6 | **Attended and No-show only from the visit's day** (org-local), since they record what happened. | Data integrity (not stated) | Unit + integration |
| 7 | **Attended (FR-152):** interest level (High, Medium, Low, None) and next action are required; objections (≤ 20) and notes are optional. A lead in Site Visit Scheduled moves to Site Visit Completed (`first_visit_completed_at` set once). | FR-152 | Integration |
| 8 | **Cancel and no-show:** when the lead is in Site Visit Scheduled and no other visit is open, it moves back to Qualified (reason "Site visit cancelled: …" / "Site visit no-show: …"). A lead in any other stage, including Site Visit Completed, is not moved (owner decisions 3–4). | Lead-lifecycle diagram; owner decisions | Integration |
| 9 | **Won/Lost:** open visits are cancelled automatically ("Lead marked as Won/Lost") in the stage change's transaction; the database refuses Won/Lost while a visit is open (as for tasks, ADR-0010). **Merge** moves all visits, with their history, to the surviving lead. **Reassignment** leaves the visit and its assignee unchanged. | Consistency with tasks | Integration; lead-merge regression |
| 10 | **Reminders (FR-150):** 15 minutes before the visit (the FR-106 default), for the assignee **and** the person who scheduled it (Workflow D), one per visit, recipient and time. Same mechanism as FR-106: a definer claim writes `site_visit_reminder` and an outbox event; the worker delivers an in-app `VISIT_REMINDER` ("Site visit at 10:30 am", meeting point; link to Site visits, not the lead). A reschedule makes the old reminder stale. Rechecked at delivery. | FR-150; Workflow D; ADR-0019 | Integration |
| 11 | **Visibility:** the lead page lists the lead's visits (`site_visit.read` over the lead). A **Site visits** page lists visits on leads in the caller's scope **and** visits assigned to them (§4.3 "+ assigned visits"). An assigned agent without lead access sees the visit and the lead's **name only**, and cannot change it (changes need `site_visit.manage` over the lead). HR has no access (RESTRICTIVE role policy). | §4.3 | Integration; DB HR sees 0 rows |
| 12 | **History:** every change writes a `site_visit_event`, a `SITE_VISIT` timeline entry and an audit entry (`site_visit.scheduled/confirmed/rescheduled/cancelled/no_show/attended`). Stage changes write the usual stage history with `related_entity` = the visit. | Lead-lifecycle §2.1 | Integration |
| 13 | **Contact:** no call or message links (G5). On a Do-Not-Contact lead no visit is created or rescheduled (owner decision 7); Invalid-number leads are unchanged; both banners still show on the lead page. | G5; owner decision | Unit (no contact links); integration (DNC) |

## Owner decisions (2026-10-30, on closing the slice)
1. **Double-booking:** a provisional **60-minute window**. When the same salesperson has another open visit starting within 60 minutes either side, scheduling or rescheduling shows a **non-blocking warning** and the save goes ahead. This is an **assumption until a visit duration is specified.** Built (`doubleBooking`); integration and browser checks.
2. **Assigned agent without lead access:** may view the visit and the lead's name, but cannot update the outcome or the lead stage. No implicit lead access. (Already so; integration test.)
3. **No-show:** returns the lead to Qualified **only** if its current stage is Site Visit Scheduled and no other visit is open (rule `SITE_VISIT_NO_SHOW`). Built; integration test.
4. **Cancel:** never regresses a lead already at Site Visit Completed. It returns to Qualified only if the current stage is Site Visit Scheduled and no other visit is open. (Already so; regression test with a lead completed by another visit.)
5. **Deactivated assignee:** visits are **not** cancelled or transferred automatically. **Operational handover gap:** an Owner/Admin must handle such visits by hand (cancel and reschedule with another salesperson); reminders to an inactive member are skipped. No reassignment policy is invented.
6. **Next action:** stays required free text. No follow-up task is created implicitly.
7. **Do-Not-Contact leads:** until the G5 review decides, a visit is **not created or rescheduled** on a Do-Not-Contact lead (application, plus database backstop in migration `0027_site_visit_dnc_guard`). Viewing history, confirming, cancelling and recording the outcome of an existing visit stay possible. No override.
8. **My Day and calendar:** open visits **assigned to the current user** appear on My Day ("Your site visits", up to the end of the 7-day window, including past ones whose outcome is due) and in their personal calendar (FR-105). Other people's visits are never shown there because of a Manager, Owner or Admin role; elsewhere lead-scope visibility is unchanged. Built (`assignedVisits`); integration and browser checks.

## Known limitations
- No customer confirmation message (Phase 6), no property availability check (FR-157), no KPI tiles (K11–K13, Phase 4 dashboards).
- The double-booking window counts visits only (not meetings or other tasks).
