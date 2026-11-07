# ADR-0016: Tasks for other people (FR-103)

- **Status:** Accepted by the owner on 2026-10-30 (FR-103 closed on its focused tests and browser checks). Implemented locally (uncommitted).
- **Date:** 2026-10-30
- **Builds on:** [ADR-0009](ADR-0009-phase-3-follow-up-slice.md), [ADR-0010](ADR-0010-follow-up-lifecycle.md), [ADR-0015](ADR-0015-task-types.md). Migration `0021_task_assignment`.

## Context
FR-103 (Phase 4, Must): "Managers create tasks for team members." Actors SM, AD; acceptance "Assignee notified". Role matrix §4.3, `task.create` for others: Owner O, Admin O, Sales Manager T, Sales Executive —, HR —. Nothing else in the requirements, workflows or domain model specifies assignment. Only what these sources state is built; open questions are listed at the end.

Owner decision 2026-10-30 (kept here): tasks with no lead are private to their assignee and readable by Owner/Admin. Managers do not see other people's no-lead tasks.

## Decisions

| # | Decision | Source / why | Enforcement / evidence |
|---|---|---|---|
| 1 | **Permission `task.assign`** (choose an assignee other than oneself): Owner ORG, Admin ORG, Sales Manager TEAM; Sales Executive, HR and support access none. Creating for oneself is unchanged (`task.create`). | Role matrix §4.3 | `permissions.ts`; `permissions.test.ts`; integration "who may assign" |
| 2 | **TEAM** = active members currently in a non-archived team the manager leads (the same team definition as lead scope). | §2.2 team scope | `assigneeFor`; DB `app.task_assignee_allowed`; integration (members outside the team refused, including after leaving it) |
| 3 | **Eligible assignee:** an ACTIVE member of the same org (never suspended, deactivated or another org's user) who could work on the task with their own grants: `task.update`, and for a lead task `lead.update` over that writable lead. A lead task is therefore never given to someone who could not open the lead. | Derived from the existing change rules (`loadForUpdate` requires these), so a task is never created that its assignee could not act on. **For owner confirmation**: see open question 1. | `assigneeFor` / `cannotWorkOn`; the "For" list offers only eligible people; integration "who may be given a task" |
| 4 | **Every task type** may be assigned, including a follow-up on a lead (FR-108 still allows one open follow-up per lead and person: "This person already has an open follow-up"). The interaction sheet still schedules only the caller's own. | FR-100 types; FR-108 | `createTask` (FOLLOW_UP routes to `scheduleFollowUpIn`); integration |
| 5 | **Unchanged rules:** a Call task on a Do-Not-Contact lead is refused, tasks on Won/Lost leads are refused, and the lifecycle (reassignment, queue, Won/Lost, merge, deactivation of the assignee) works on the assignee as before. The creator leaving changes nothing. | ADR-0010, ADR-0015 | Integration "existing rules still apply" |
| 6 | **Visibility unchanged:** task scopes are as before (assignee; TEAM = tasks on team leads or assigned to the manager; ORG for Owner/Admin). A manager who gives a team member a **no-lead** task cannot see or change it afterwards. | Owner decision 2026-10-30 | Integration (NOT_FOUND for the manager, absent from their My Day; Admin can) |
| 7 | **Atomic:** the task, its timeline and audit entries (with `assigneeUserId` when someone else) and the notification event are written in one transaction. | NFR / outbox pattern (ADR-0005) | `createTask`, `scheduleFollowUpIn` |
| 8 | **"Assignee notified":** outbox event `task.assigned`; the worker writes one in-app `TASK_ASSIGNED` notification ("Task assigned to you" / "Follow-up assigned to you"; body = type and title; link = the lead page or My Day). It is skipped when the task is no longer open or no longer theirs, or the assignee is inactive. Redelivery is a no-op (unique per event and recipient, and per task and recipient). No email or push. | FR-103 acceptance; FR-118 in-app notifications | Migration 0021 (type, data check, unique index); `notifications.build`; integration |
| 9 | **Database backstop:** the RESTRICTIVE insert policy of 0012 is replaced. The creator must still be the session user, and the assignee must be the session user, or (Owner/Admin) an active org member, or (Sales Manager) an active member of a team they lead. Lead-access eligibility is application-only. | Defence in depth, as for every insert policy | `app.task_assignee_allowed`; integration as `crm_app` (42501) |
| 10 | **UI:** a "For" list (Me first, then eligible people, at most 200) on the lead page's Tasks card (with a Follow-up option when assigning) and on My Day's Add a task form. Rows show "Assigned by …" when the creator is someone else. | FR-103 | `follow-up-row.tsx` (unit test), `my-day/page.tsx`, lead page |

## Owner decisions (2026-10-30, on acceptance)
- **D1 (confirms decision 3):** a lead task cannot be assigned to a member who lacks permission to access and work on that lead. No implicit or temporary lead access is granted.
- **D2 (confirms decision 6):** no-lead tasks stay private to the assignee and Owner/Admin. Managers do not see other people's no-lead tasks because they assigned them.
- **D3:** tasks are **not** reassigned or cancelled automatically when an active assignee leaves a manager's team. This stays an unresolved lifecycle requirement until it is specified.

## Open questions (not built; need an owner decision)
1. ~~Lead-task eligibility~~: decided, D1.
2. **Reassigning an existing task** to another person (by its creator, a manager or the assignee) is not specified: not built. Workflow C mentions "reassignment by manager" in its audit line only.
3. **Assignee leaves the manager's team:** their tasks stay with them (D3: unresolved until specified).
4. ~~Manager visibility of no-lead tasks they assigned~~: decided, D2 (a role-matrix grant would be needed to change it).
5. **Notification channels** beyond in-app (FR-119 push/email preferences) are Phase 4 FR-119.

## Known limitations
- The lead page computes the "For" list by checking each candidate's lead access (one query per member, at most 200). That is fine for pilot-sized orgs; larger orgs need a set-based check.
- The browser check of this slice is in the slice report.
