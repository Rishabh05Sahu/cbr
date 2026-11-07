# ADR-0015: Task types beyond follow-ups (rest of FR-100)

- **Status:** Accepted by the owner on 2026-10-30 (FR-100 closed on its focused tests and browser check). Implemented locally (uncommitted).
- **Date:** 2026-10-29
- **Builds on:** [ADR-0009](ADR-0009-phase-3-follow-up-slice.md), [ADR-0010](ADR-0010-follow-up-lifecycle.md), [ADR-0012](ADR-0012-contact-status.md). Migration `0020_task_types`.

## Context
FR-100 (Phase 3, Must) asks for "tasks with type (Follow-up, Call, Meeting, Document, Other), due at, priority, assignee, optional lead/property link". Slice 1 built follow-ups only (ADR-0009 #1), and the `task` table already allowed every type. This slice adds the other four types, with or without a lead. It was chosen as the next Phase 3 item because the remaining Phase 3 acceptance items, FR-080–082, wait for G5. It enables no contact.

The owner decided four questions on 2026-10-29: lead tasks follow the follow-up lifecycle; no-lead tasks are cancelled on deactivation; a new Call task is refused on a Do-Not-Contact lead; Meeting is a type with a start time only.

## Decisions

| # | Decision | Source / why | Enforcement / evidence |
|---|---|---|---|
| 1 | **Types:** Call, Meeting, Document and Other are created by `createTask`; follow-ups keep their own command. Every type except a follow-up needs a title (1–200 characters). Priority is Low, Normal, High or Urgent (default Normal). | FR-100; a task without a follow-up's lead context must say what it is | Zod input; DB `task_title_required`; integration "validates the type, title and time" |
| 2 | **Assignee = creator**, as for follow-ups. A supplied assignee is ignored. | ADR-0009 #4; creating for others is FR-103 (Phase 4) | RLS `actor_is_session_user`; integration test |
| 3 | **Lead optional.** On a lead, the caller needs `lead.update` on a writable, open lead (not archived, merged, Won or Lost). Without a lead, `task.create` is enough. Any number may be open: the one-open limit and `lead.next_follow_up_at` are for follow-ups only (FR-108). | FR-100 "optional lead link"; FR-108 names follow-ups | `createTask`; `task_lead_open_guard` (0013); integration tests |
| 4 | **Property link:** not built. | Properties arrive in Phase 5. | — |
| 5 | **Meeting = start time only.** End time, location, attendees and the overlap warning come with FR-104. | Owner decision 2026-10-29 | UI copy on both forms |
| 6 | **Call task on a Do-Not-Contact lead is refused.** Other types are allowed. Existing tasks are not changed when a lead becomes Do-Not-Contact, and Invalid-number leads are unaffected. A task never contacts anyone: there is no dialler or link. | Owner decision 2026-10-29; ADR-0012 (DNC is a hard block on outbound contact) | `createTask` (RULE_VIOLATION); DB trigger `task_call_dnc_guard` (23514 as `crm_app`); the Call option is disabled on the lead page with the reason |
| 7 | **Lifecycle (lead tasks):** every open task on a lead follows ADR-0010. It moves with the lead's owner on reassignment, is cancelled with a reason when the lead goes to a queue or becomes Won/Lost, goes to the lead's active owner when its assignee is deactivated, and moves on merge. The collision rule stays for follow-ups only. | Owner decision 2026-10-29 ("same as follow-ups") | `follow-up-lifecycle.ts`, `merge.ts` (already moved all open tasks); `lead_closed_follow_up_guard` replaced in 0020 to refuse Won/Lost while **any** task is open; integration tests |
| 8 | **Deactivation (no-lead tasks):** the member's open tasks with no lead are cancelled with the reason "Assignee deactivated", in the deactivation transaction, with one `task.cancelled` audit entry (entity: the user). | Owner decision 2026-10-29. `membership_open_tasks_guard` (0013) already refused deactivation while any task was open. | `handOverFollowUpsOf`; integration test |
| 9 | **Permissions:** the existing task grants apply to every type. HR gets `task.create`, `task.update` and `task.read` for **their own** tasks. With no lead grants, HR cannot create or change a task on a lead. A no-lead task is visible to its assignee and to Owner/Admin (ORG task scope). A manager's TEAM scope covers tasks on team leads, so team members' no-lead tasks stay private (**owner decision 2026-10-30**: private to the assignee and readable by Owner/Admin only). | Role matrix §4.3 (HR: "✓ (non-lead tasks)", "S (own)"); §2.2 "users' own tasks are always visible to them". `task.read` for HR is "—" in the matrix; OWN is read as the §2.2 rule. | `permissions.ts`, `permissions.test.ts`; integration "keeps a no-lead task to its assignee" |
| 10 | **Changing (FR-102):** reschedule, complete and cancel work for every type with the same rules: a reason after two reschedules or when overdue, a reason to cancel, optimistic version, closed is final. The interaction sheet still changes follow-ups only. | FR-102 | `loadForUpdate(followUpOnly)`; integration tests |
| 11 | **History:** timeline entries (`TASK`) and audit entries carry `taskType` for every type except a follow-up, so older entries still read as follow-ups. A no-lead task writes audit entries only. | Existing timeline/audit conventions | Integration tests |
| 12 | **Where they appear:** the lead page has a **Tasks** card listing the lead's other tasks, with a form to add one. **My Day** shows own open tasks of every type in its FR-101 sections, adds a form for no-lead tasks, lets no-lead tasks be completed, rescheduled and cancelled in place, and lists open tasks due after the 7-day window under **Later** (at most 50). A lead's tasks are still changed on the lead page. | FR-101 lists overdue, today, upcoming; **Later** is an addition so a task due further ahead stays visible somewhere. | `my-day/page.tsx`; `follow-up-row.tsx` (shared row) and its unit test; integration "My Day with every task type" |

## Known limitations
- FR-103 (tasks for others) is built: [ADR-0016](ADR-0016-task-assignment.md). FR-104 (meeting details, overlap warning; built: [ADR-0017](ADR-0017-meeting-details.md)), FR-105 (calendar), FR-106 (reminders), FR-107 (recurring) are Phase 4.
- Not built: the property link (Phase 5) and a task description field (domain model, not in FR-100).
- No task list beyond My Day and the lead page (no filters or search across tasks). **Later** shows the 50 earliest only.
- A task on a lead that the caller can no longer open is listed on My Day without lead details. It cannot be changed there.
- Changing an open Call task after its lead becomes Do-Not-Contact is not blocked (owner decision: existing tasks unchanged). The lead page and the interaction sheet still show the DNC banner and rules.
- Browser check of this slice: see the slice report.
