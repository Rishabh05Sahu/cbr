# ADR-0025: Call and WhatsApp launchers and the outcome prompt (FR-080/081/082)

- **Status:** Proposed. Implemented on `qa` on 2026-11-12; awaiting owner review. Migration `0028_call_intents` is **not yet pinned** for Supabase (`scripts/db/migrate-supabase.mjs`).
- **Date:** 2026-11-12
- **Approval:** owner, 2026-11-12: "approve FR-080–082 for test data". **Legal gate G5 stays open**: this does not clear the product for real customer data or outbound contact (B1 personal SIMs, A3 DND scrubbing).
- **Builds on:** [ADR-0006](ADR-0006-calling-integration-strategy.md) (Phase 3 = `tel:` / `wa.me` launchers), [ADR-0012](ADR-0012-contact-status.md), [ADR-0013](ADR-0013-phone-masking.md), [ADR-0014](ADR-0014-manual-interactions.md).

## Decisions

| # | Decision | Source / why | Enforcement / evidence |
|---|---|---|---|
| 1 | **Buttons:** "Call" (`tel:+91…`) and "WhatsApp" (`https://wa.me/91…`) in the Contact card of the lead page, for people who may log interactions on this writable lead (`interaction.create` in scope: Owner, Admin, Manager for their teams, Executive for own leads). Not HR, not platform support. A "Mobile / Alternate" choice appears when the lead has an alternate number. | FR-080/081, ADR-0006, workflow B | `recordCallIntent`; integration tests (scope, roles, other org) |
| 2 | **Tap first, link second:** the button calls the server, which records a `call_intent` row and only then returns the link. The page never contains the number or a link before a tap. | Masking (decision 4) and FR-065 must apply to every dial | Component test (no number/link in HTML) |
| 3 | **Contact status:** Do-Not-Contact shows no buttons and the server refuses the tap (no override). An Invalid number needs a confirmation checkbox, stored as `invalid_number_confirmed`. Uses `assertOutboundAllowed` (MANUAL_CALL / MANUAL_WHATSAPP). | FR-065, ADR-0012 | App + `call_intent_guard` trigger; tests |
| 4 | **Masking:** with phone masking on, each tap is a reveal: it needs `lead.reveal_phone`, counts towards the daily cap and writes `lead.phone_revealed`. The reveal id is stored on the intent, and the database refuses a masked-org tap without this person's reveal of this lead from the same transaction. | ADR-0013 known limitation ("dialling a masked number counts as a reveal") | `dialNumberIn`; trigger; tests (cap shared with reveals) |
| 5 | **A tap is not a call:** `call_intent` is metrics level L0. Nothing else changes: no interaction, stage, milestone or lead version. | metrics L0, ADR-0006 | Test |
| 6 | **Append-only, no link column:** "logged" is derived (an interaction by the same person on the same lead logged after the tap), as K08b defines it. The domain model's `interaction_id` and `client_context` (device type) are not stored: nothing needs them yet, and the device type is avoidable data. | domain-model §CallIntent; data minimisation | No UPDATE/DELETE grant; test |
| 7 | **Outcome prompt (FR-082):** for two hours after a tap with nothing logged since, the lead page shows "You tapped Call at … How did it go?" with **Log the outcome** (jumps to the outcome sheet, prefilled with the channel and the tap time) and **Not now**. "Not now" hides it for that tap in this browser only (local storage); the tap still counts as unlogged. When the person returns to the tab, the page refreshes so the prompt appears. WhatsApp taps prefill "WhatsApp message" (the button opens a chat); the person can change it. | FR-082 ("intent < 2 h old and unlogged; dismissible") | `pendingCallIntent`; tests |
| 8 | **Opening the link:** Call navigates to `tel:`. WhatsApp opens `wa.me` in a new tab (falls back to the same tab if blocked); on a phone it hands off to the app. A "tap here" link is shown if nothing opened. | Desktop keeps the CRM open | Manual check on devices pending |

## Not built (follow-ups)
- ~~**Dashboards:**~~ Built 2026-11-13 (owner approval "approve K04/K08b dashboard"): **K04** Call-button taps and WhatsApp-button taps; **K05** split into logged phone calls and logged WhatsApp calls and messages (K05 itself unchanged); **K08b** taps followed by an interaction the same person logged on that lead within 2 h. These are in the KPI tiles, the per-member table and the drill-downs (`src/modules/reporting/queries.ts`, one row set per tile, the same report.read scopes). A tap is never counted as a call. Platform staff under a support grant see zero taps, because `call_intent_read` has no read-only support clause, unlike `interaction_read`.
- **My Day:** buttons on My Day rows and an "Unlogged calls (24 h)" list (workflow B alternative path).
- **Retention:** one year per the domain model; no purge job yet (G5 retention awaits counsel, as for interactions).
- **Device check:** behaviour on real Android/iOS browsers has not been verified.
