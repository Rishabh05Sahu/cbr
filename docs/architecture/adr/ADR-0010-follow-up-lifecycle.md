# ADR-0010: Follow-up lifecycle: handover and Won/Lost

- **Status:** Proposed. Implemented locally (uncommitted) on 2026-10-28; awaiting owner review.
- **Date:** 2026-10-28
- **Builds on:** [ADR-0009](ADR-0009-phase-3-follow-up-slice.md). Migration `0013_follow_up_lifecycle`.

## Context
Phase 3 slice 2 (owner approval 2026-10-28) closes two gaps left by slice 1: open follow-ups when a lead changes owner or its assignee is deactivated (FR-077), and open follow-ups when a lead becomes Won or Lost.

Sources:
- **FR-077:** "Deactivating a user forces a decision on their open leads/tasks (reassign to user/team queue)."
- **Workflow G step 3:** on reassignment, "move open lead tasks to the new owner (default; configurable 'leave tasks with previous owner')". The setting does not exist, so the default applies.
- **FR-108:** one open follow-up per lead per person.
- **lead-lifecycle §2:** Won is terminal; Lost may be reopened by a manager.

## Code paths covered
- **Ownership changes:** every one goes through `moveLead()` in `leads/assignment.ts` (manual assign, bulk assign, round-robin, deactivation handover). Bulk "change team" keeps the owner, so follow-ups are untouched. Imports only create new leads.
- **Deactivation:** the only path is `members.closeMembership(DEACTIVATED)`.
- **Won/Lost:** stage changes go through `leads.changeStage()`.
- **Merge:** already moves open follow-ups (ADR-0009 #8).

## Decisions

| # | Decision | Source / why | Enforcement / evidence |
|---|---|---|---|
| 1 | **Reassignment:** the previous owner's open follow-ups on the lead move to the new owner (assignee change, version +1). Other people's follow-ups on the lead stay with them. | Workflow G step 3 (default). The previous owner usually loses access; other assignees keep theirs through their own scope. | `handOverLeadFollowUps` in `moveLead`; integration tests (manual, bulk, team change) |
| 2 | **Reassignment to a queue (no owner):** the previous owner's open follow-ups are cancelled with the reason "Lead moved to a queue without an owner". | *Not specified.* No person exists to receive them, and an assignee is required. Cancelling with a recorded reason keeps history and loses nothing silently. The next owner schedules their own. | Integration test |
| 3 | **Collision:** if the destination person already has an open follow-up on the lead, theirs is kept and the incoming one is cancelled with a reason. | FR-108 allows one open follow-up per lead per person. Same rule as merge (ADR-0009 #8), so the lifecycle rules agree. | Integration tests (reassignment and deactivation) |
| 4 | **Deactivation:** the member's own open leads go to the chosen handover target as before, and their follow-ups follow (decision 1). Each remaining open follow-up (on other people's leads) goes to that **lead's active owner**, or is cancelled with a reason if the lead has none. A handover choice is still asked only when they own open leads. | FR-077 plus workflow G: follow-ups belong with the lead's owner, who always has access to the lead. *Not specified* for follow-ups on others' leads; the lead's owner was chosen over the handover target because the target may lack access to those leads. | `handOverFollowUpsOf` in `closeMembership`; DB `membership_open_tasks_guard` refuses deactivation while open tasks remain |
| 5 | **Won/Lost:** every open follow-up on the lead is cancelled ("Lead marked as Won" / "…as Lost") in the stage change's transaction. Reopening a Lost lead does not revive them. | *Not specified* in lead-lifecycle. A closed lead must not show a next follow-up (consistent with ADR-0009 #7: no scheduling on closed leads). | `closeFollowUpsForStage` in `changeStage`; DB `lead_closed_follow_up_guard` refuses the stage change if any remain open, and `task_lead_open_guard` refuses a follow-up created on a closed, merged or deleted lead |
| 6 | **Handover target must be an active member** of the org. | Never hand work to an inactive person. | `task_guard` (replaced in 0013 with the same checks plus this one) |
| 7 | **History:** completed and cancelled follow-ups never change. Each move or automatic cancellation writes a `TASK` timeline entry (`handed_over` or `cancelled` with `automatic: true`) and one audit entry per lead (`task.handed_over` / `task.cancelled`). `next_follow_up_at` follows through its trigger. | ADR-0009 #3, #6 | Integration tests |
| 8 | **crm_app may update `task.assignee_user_id`** (needed for handover). Application rules decide who may trigger a handover (`lead.assign`/`lead.reassign`, `user.remove`); the database keeps the assignee active. | Minimum extra grant | Migration 0013 |

## Known limitations
- **Update 2026-10-29 (ADR-0015, migration 0020):** these rules now apply to a lead's open tasks of every type (collisions: follow-ups only), and a deactivated member's open tasks with no lead are cancelled with a reason.
- **Suspension** (temporary) does not hand over follow-ups. FR-077 covers deactivation only; a suspended person's follow-ups wait for them.
- **The "leave tasks with previous owner" setting** (workflow G) is not implemented.
- **Nurture:** "Nurture until date (creates a follow-up task)" from lead-lifecycle is not implemented. It is a separate requirement.
- **Notifications:** none are sent for handed-over follow-ups. The lead assignment notification still goes to the new owner.
