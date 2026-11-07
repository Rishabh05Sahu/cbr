# ADR-0012: Contact status and Do-Not-Contact (FR-065)

- **Status:** Proposed. Implemented locally (uncommitted) on 2026-10-28; awaiting owner review.
- **Date:** 2026-10-28
- **Builds on:** [ADR-0004](ADR-0004-multi-tenancy-and-permissions.md), [ADR-0006](ADR-0006-calling-integration-strategy.md). Migration `0015_contact_status`.

## Context
Phase 3 slice 6 (owner approval 2026-10-28) implements FR-065 only. Calling and WhatsApp launchers (FR-080–082), outcome logging (FR-083–084), the timeline of communications (FR-085), phone masking (FR-060) and the lead workspace (FR-057) are not built.

Sources:
- **FR-065:** "Contact status / Do-not-contact: blocks call buttons and messaging with a visible banner." Acceptance: "DNC leads cannot be messaged via integrations; manual call shows warning requiring confirmation."
- **Workflow B precondition:** `contact_status = OK` (otherwise a warning is shown and a confirmation required).
- **lead-lifecycle §1, §4, §6:** contactability is its own dimension (`OK`, `DO_NOT_CONTACT`, `INVALID`), changed by a customer request, a wrong number or consent withdrawal. A contact status change is a sensitive change: timeline entry plus audit, with personal data shown as "changed" in audit.
- **lead-lifecycle §3:** outcome `CONNECTED_DO_NOT_CALL` sets `DO_NOT_CONTACT` and records a consent-withdrawal entry (applies once outcomes exist).
- **Threat model T16 and §8:** consent and contact-status checks in the send command (server); `contact_status` is the fast check, updated in the same transaction as the consent withdrawal.
- **Legal checklist C3/C4:** one `contact_status` per lead that blocks all outbound launchers, effective immediately, audited; withdrawal is recorded and stops future sends.

### Conflict resolved
FR-065's acceptance text and workflow B allow a manual call to a non-OK lead after a confirmation. C3 and the threat model plan a hard block, and the owner instructed on 2026-10-28 that Do-Not-Contact must not be an overridable warning. Resolution: **Do-Not-Contact blocks every channel with no override**. Workflow B's warning-plus-confirmation is kept for `INVALID` only. This is stricter than FR-065's acceptance text; it weakens nothing.

## Decisions

| # | Decision | Source / why | Enforcement / evidence |
|---|---|---|---|
| 1 | **States:** `OK`, `DO_NOT_CONTACT`, `INVALID` (the existing column and CHECK from 0003). | lead-lifecycle §4 | 0003 CHECK |
| 2 | **Transitions:** OK/INVALID → DNC and OK ↔ INVALID by anyone with `lead.update` in the lead's scope (Sales Executive on own leads, Manager in team scope, Owner/Admin org-wide). DNC → OK only by Owner/Admin (`lead.lift_do_not_contact`). DNC → INVALID is refused, because it would weaken the restriction. No-op changes are refused. | FR-065 actors SE/SYS; role matrix §4.1 (`lead.update`); **owner decision 1** (lifting) | `contactability.ts`; `lead_contact_status_event_guard` (role checked in the database through `app.current_member_role()`) |
| 3 | **Required details:** every manual change needs a reason. DNC also needs how it was asked for (`VERBAL`, `WRITTEN`, `OTHER`); evidence reference is optional. Lifting DNC needs a consent basis (`VERBAL`, `WRITTEN`, `FORM_OPT_IN`, `INBOUND_ENQUIRY`) **and** an evidence reference. | lead-lifecycle §6 ("why"); C4 (evidence of withdrawal); owner decision 1 | Validation in app and DB guard |
| 4 | **Evidence record:** `lead_contact_status_event`, append-only (no UPDATE/DELETE grant). A change to DNC is the lead's consent-withdrawal record. Inserting the event is the **only** way to change `lead.contact_status`: its trigger updates the lead (version + 1) and writes the `CONTACT_STATUS` timeline entry and the `lead.contact_status_changed` audit row in the same transaction. A direct UPDATE of the column is refused. | T16/§8 ("same transaction"); lead-lifecycle §6 | Triggers in 0015; integration tests |
| 5 | **No personal data in audit:** audit and timeline carry statuses, origin and method only. Reason and evidence text stay on the event (they may hold personal data). | lead-lifecycle §6 | Test that audit metadata holds no reason/evidence text |
| 6 | **Archived lead:** only → DNC can be recorded, so a stop request never waits for a restore. **Merged lead:** no change (the survivor is the lead). **Won/Lost:** status unaffected by stage changes; changes allowed. **Reassignment:** status stays with the lead. | lead-lifecycle §1 (independent dimension); C3 ("effective immediately") | DB guard; tests |
| 7 | **Merge:** a DNC duplicate makes the survivor DNC (event origin `MERGE`), recorded before the tombstone. The preview says so. INVALID is not carried, because it describes a number, not the person. | Same person (FR-062); C3 | Merge command; DB refuses merging a DNC lead into a non-DNC survivor |
| 8 | **Returning number:** a new lead linked to a closed DNC lead (`previous_lead_id`, same primary phone) starts DNC (event origin `CARRY_OVER`). This applies to manual create and import alike. The new enquiry is not treated as consent. | **Owner decision 3** | BEFORE/AFTER INSERT triggers on `lead`; tests for both paths |
| 9 | **Outbound rule** (`outboundEligibility`, `assertOutboundAllowed`): DNC blocked on every channel; INVALID: manual call/WhatsApp only after confirmation, integration call/message blocked; OK allowed. `assertOutboundAllowed` takes `FOR SHARE` on the lead inside the caller's transaction. | FR-065, T16, integration-strategy §6 step 1; **owner decision 2** (INVALID integrations) | Unit and integration tests. **No launcher calls it yet.** |
| 10 | **Visibility:** the status, banner and history are shown to anyone with `lead.read` in scope. HR and support sessions cannot read the events in the database. | Role matrix §4.1 | RLS `lead_roles_read` |
| 11 | **ConsentRecord scope:** the per-channel, per-purpose `ConsentRecord` (domain model §2.2; opt-ins, A2) is **not** built. The event table is the FR-065 withdrawal and lift record. | Brief: no broad consent subsystem | — |

## Known limitations and open items
- **Manual interaction records (2026-10-29, ADR-0014)** apply the outbound rule: outbound records on a Do-Not-Contact lead are refused (app and database), Invalid needs a confirmation, inbound records are allowed and change nothing. Outcome-driven changes use this event path in the same transaction.
- **End-to-end outbound enforcement is not complete.** No call, WhatsApp or integration launcher exists. FR-080–082 and provider sends must call `assertOutboundAllowed` in the transaction that records the intent or send. The tables they add should also refuse DNC leads in the database.
- **Legal gate G5 stays open.** B1 (personal-SIM calling) and A3 (DND / preference scrubbing) are not resolved by this slice. The CRM records a brokerage's own do-not-contact list; it does **not** check TRAI DND / NCPR registrations.
- **C3 "how quickly" across channels**, the retention period of the evidence (domain model says lifetime + 3 years, needs legal review) and the evidence wording need counsel.
- **Opt-out signals** (WhatsApp "STOP", outcome `CONNECTED_DO_NOT_CALL`) will set DNC through this same event path once those features exist.
- **Lead list and export:** the list shows no contact-status column or filter, and the export does not include contact status (unchanged).
- **Phone edits:** there is no flow for editing a lead's primary phone yet. When one is added, it must decide whether INVALID is reset (today a person records INVALID → OK).
