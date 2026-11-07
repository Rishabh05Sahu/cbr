# Calling and WhatsApp Capability Research

> **Date verified: 2026-10-19** (initial pass and a second targeted pass, §1.1). Sources are official vendor/regulator documentation unless marked *(secondary)*. Provider capabilities, prices and policies change often, so **re-verify every row before Phase 6 commits to a provider.** This is not legal advice. Regulatory points are summarised in [compliance-and-regulatory-notes.md](compliance-and-regulatory-notes.md).
>
> Status legend: **VERIFIED** (official doc states it) · **PREREQ** (supported, subject to prerequisites) · **UNCERTAIN** (could not confirm) · **NOT SUPPORTED**

## 1. Capability matrix

| # | Capability | Status | What the CRM can record | Phase |
|---|---|---|---|---|
| 1 | Open native dialer via `tel:` link | **VERIFIED** (MDN, RFC 3966, Apple Phone Links). iOS shows a confirmation; numbers with `*`/`#` are not dialled on iOS. Android `ACTION_DIAL` pre-fills the dialer (UNCERTAIN: not re-verified from an official page this session). Desktop depends on an OS handler (Phone Link, FaceTime) and may do nothing | **Only the tap** (CallIntent, L0). The page receives no callback for dialled/answered/duration | 3 |
| 2 | Launch a third-party telephony app (provider softphone/dialer app) | **UNCERTAIN / provider-specific**. Depends on the provider exposing a deep link. Not evaluated per provider | Tap only, unless the provider sends webhooks for calls made from its app | 6 (optional) |
| 3 | Cloud telephony click-to-call (agent-first call bridging) | **VERIFIED** for Exotel and Tata Tele Smartflo (public APIs). PREREQ: account, KYC, virtual number/caller ID, India-registered entity | Provider call id, status events, duration, recording reference (if enabled) | 6 |
| 4 | Capture actual call attempts and completion | **VERIFIED via provider webhooks only** (Exotel `StatusCallback` terminal/answered; Smartflo per-trigger webhooks, which support must enable) | L2/L3 measurements | 6 |
| 5 | Capture duration and recordings | **VERIFIED** (Exotel `Record=true`, mp3, `RecordingUrl`; Ozonetel `AudioFile`; MyOperator disposition webhook). Recording is a **legal/consent decision**, not just a technical one | Duration (provider), recording file (copied into our storage) | 6 |
| 6 | Open WhatsApp chat (`https://wa.me/<number>` with optional `?text=`) | **VERIFIED** (WhatsApp Click-to-Chat FAQ, read via quotes; the official page did not render). The user then taps the call icon **manually** | Tap only (CallIntent channel WhatsApp) | 3 |
| 6b | A link that directly starts a WhatsApp voice call to a **lead** | **NOT SUPPORTED**. No documented link places a call to an arbitrary personal number. `wa.me/call/<number>` exists only for a **business** number with Calling API enabled, as a *user-initiated* call to the business, and is not supported on WhatsApp desktop | — | — |
| 7 | Programmatically initiate a WhatsApp Business call (business-initiated, Cloud API Calling API) | **PREREQ, India availability inferred.** Business-initiated calling is unavailable when the business number is in US, Canada, Egypt, Vietnam or Nigeria (Twilio's list also excludes Türkiye). India is **not** on the exclusion list, and Infobip lists India as supported, but Meta does not name India positively → **confirm with BSP**. Prerequisites: Cloud API number (not the WhatsApp Business app); messaging limit ≥ 2,000 unique recipients/day; calling enabled; payment method; `calls` webhook subscription; **user call permission** (request via `call_permission_request` message, max 1/24 h and 2/7 days; temporary grant 7 days or permanent; auto-revoked after 4 consecutive unanswered calls); **we must host a WebRTC endpoint (browser softphone) or a SIP endpoint**. The agent talks through the browser/SIP, not their phone's WhatsApp | Call id, `connect`/`status`/`terminate` webhooks with start/end/duration, recording (opt-in, announced, download within 7 days) | 6 (PoC first) |
| 7b | User-initiated WhatsApp calls to the business (customer taps call button) | **VERIFIED**. Available wherever Cloud API is, free to receive. Still needs our WebRTC/SIP endpoint to answer | Same as 7 | 6 |
| 8 | Record WhatsApp calling events in the CRM | **VERIFIED** for Calling API calls (webhooks). **NOT SUPPORTED** for calls made from a salesperson's personal WhatsApp app | — | 6 |
| 9 | Send WhatsApp messages and receive webhooks (Cloud API via Meta or a BSP) | **VERIFIED**. Templates outside the 24 h customer-service window; free-form inside it. Per-message pricing since 1 Jul 2025. From 1 Oct 2026, service messages beyond the free tier (first 1,000/month per number) and utility messages inside the window are charged. **India: accounts must migrate to INR billing by 31 Dec 2026.** Webhooks signed with `X-Hub-Signature-256` (SHA-256 with app secret); retried up to 36 h | Message id, sent/delivered/read/failed, inbound messages | 6 |

### Key conclusion for Phase 3

The salesperson-facing **"Call" and "WhatsApp" buttons in Phase 3 are launchers, not integrations.** They produce L0 evidence only. Everything else is manual logging (L1). Dashboards must label these figures as such (see [metrics-and-kpis.md](../product/metrics-and-kpis.md)).

### 1.1 Re-verification notes (2026-10-19, second pass)

- **Meta business-initiated calling:** Meta's page says it is "available in every location Cloud API is available, except" US, Canada, Egypt, Vietnam and Nigeria. It **also requires the business number's country code to be on a supported list that could not be extracted**. India/+91 therefore remains **UNVERIFIED (inferred only)**. Confirmed: 2,000 unique-recipient daily messaging limit; permission requests 1/day and 2/week per user; 4 consecutive unanswered calls auto-revoke permission; business-initiated calls per user raised to 100/day (changelog 19 Dec 2025); INR calling rate cards effective 1 Apr 2026 (India per-minute rate not extracted, UNVERIFIED).
- **Exotel webhooks:** **no signature/HMAC documented**. Docs advise checking Exotel IP ranges, but **no IP list is published** (the IP-whitelisting page returns 404; support may provide it, UNVERIFIED). Retries: up to 2, endpoint must answer 200 within 15 s, form-encoded POST. `CustomField` (≤ 128 chars) is passed to StatusCallback in the extended payload (requires `StatusCallbackEvents`). Recording retention is inconsistent across Exotel pages (30–365 days by plan), so confirm per contract.
- **Smartflo webhooks:** **no authentication documented**. A "Headers" option exists, but whether it sends real HTTP headers is UNVERIFIED. Retries: 2 attempts (30 s then 10 s). `custom_identifier` is confirmed on `/v1/click_to_call_support` (≤ 10 identifiers, ≤ 512 chars, returned unchanged), **not confirmed on `/v1/click_to_call`**. `ref_id` is returned for matching.
- **Exotel WhatsApp Business Calling:** still described as **Beta** (Dec 2025 blog). GA status UNVERIFIED.
- **Design consequence:** because neither shortlisted telephony provider signs webhooks, verification relies on the secret path token, HTTPS, IP allow-listing where obtainable, and **mandatory reconciliation against the provider's call-details API** before provider data counts as "verified" in KPIs (integration-strategy §5). PoC-2 must test spoofed callbacks.

## 2. Provider comparison (India)

| Provider | Click-to-call API | Webhooks | Recording | Numbers | Public pricing | WhatsApp | Docs quality | Verification |
|---|---|---|---|---|---|---|---|---|
| **Exotel** | VERIFIED: `POST /v1/Accounts/{sid}/Calls/connect` rings `From` (agent) then `To`; `CallerId` = ExoPhone | VERIFIED: `StatusCallback`, events terminal/answered, JSON or form; statuses queued/in-progress/completed/failed/busy/no-answer; final duration/price can lag ~2 min | VERIFIED (`Record=true`, single/dual channel, mp3) | ExoPhone virtual numbers | Not public ("contact sales") | Meta BSP for messaging (VERIFIED). WhatsApp Calling ran as a 2024 beta; **current status UNCERTAIN** | Good public reference | VERIFIED (API) / UNCERTAIN (WA calling) |
| **Tata Tele Business Services Smartflo** | VERIFIED: `POST https://api-smartflo.tatateleservices.com/v1/click_to_call`, bearer token, `agent_number`, `destination_number`, `caller_id`, `custom_identifier` (echoed in webhooks); async (200 = queued) | VERIFIED (configurable per trigger; must be enabled by support) | Likely; payload fields UNCERTAIN | Pilot number / assigned caller ID (operator-owned, strong for CNAP/caller-ID trust) | Not public | WhatsApp messaging *(secondary)*; calling UNCERTAIN | Good, with some inconsistencies (caller_id optionality) | VERIFIED (API) |
| **Ozonetel CloudAgent** | VERIFIED-ish (`AgentManualDial`; agent must be logged in, via a LeadSquared doc) | VERIFIED (post-call callback URL, immediate or 5-min batches) | VERIFIED (`AudioFile`) | DID/campaign | Not public | WhatsApp contact-centre product; Meta Calling UNCERTAIN | Contact-centre oriented, heavier | PARTIAL |
| **MyOperator** | VERIFIED (KB: "Click-o-call") | VERIFIED (HTTPS JSON webhooks, 2025 update; disposition webhook with recording URL) | VERIFIED | Virtual + toll-free | VERIFIED page: ₹1,250 (inbound) / ₹2,500 (Growth incl. outgoing + click-to-call) per user per month + GST, billed annually. Plan lineup may have changed (UNCERTAIN) | WhatsApp Business API (BSP); calling UNCERTAIN | KB-level docs | VERIFIED (KB) |
| **Knowlarity** | UNCERTAIN (official developer portal not retrievable; third-party docs show Click-2-Call) | UNCERTAIN | UNCERTAIN | SR numbers | Not found | UNCERTAIN | Could not assess | UNCERTAIN |
| **Plivo (India)** | PREREQ: India-registered entity + KYC (CoI, GST); both call legs must be in India (media anchoring); caller ID must be a Plivo-rented Indian number; 140-series not available | VERIFIED (standard Voice API) | VERIFIED | Indian numbers ~₹250/month | VERIFIED but inconsistent: ₹0.40 vs ₹0.60/min outbound, 60 s billing | — | Excellent developer docs | VERIFIED |
| **Twilio (India)** | **NOT SUPPORTED** for domestic India calling ("outbound calls to India can only be made from international numbers") | n/a | n/a | No domestic outbound numbers | n/a | Documents WhatsApp Business Calling as a BSP | Excellent | VERIFIED (not suitable for voice) |
| **Meta WhatsApp Cloud API (direct) or BSP** (Infobip, Twilio, 360dialog, Gupshup etc.) | Calling API as in §1 row 7 | VERIFIED | VERIFIED (opt-in, announced; Hindi/Kannada/Telugu announcement languages supported) | WhatsApp business number | Calling: user-initiated free; business-initiated billed per 6-second pulse by callee country + volume tier (India rate not extracted, one *(secondary)* figure USD 0.0056/min, **unverified**). Messaging: per template message by category; INR rates not extracted | — | Good, with recent URL migration to `/documentation/business-messaging/whatsapp/` | VERIFIED (mechanics) / UNCERTAIN (India business-initiated, rates) |

### Shortlist (recommendation, not a final selection)

1. **Cloud telephony, Phase 6 PoC:** **Exotel** and **Tata Tele Smartflo**. Both have public click-to-call and webhook APIs and Indian number provisioning, and both support passing our correlation id (Exotel `CustomField`/callback params, Smartflo `custom_identifier`). MyOperator is the third option if per-seat pricing is preferred.
2. **WhatsApp messaging:** a Meta BSP with Indian presence and INR billing, or Meta Cloud API directly. Decide on onboarding effort and support. Shortlist candidates must document webhooks, templates and calling. **OD-12.**
3. **WhatsApp business-initiated calling:** only after a PoC proves (a) availability for our +91 business number, (b) the permission flow works with real leads, and (c) the browser WebRTC softphone works on Android Chrome over 4G. Until then, the WhatsApp button launches the app (capability 6).

## 3. Costs (indicative, needs quotes)

| Item | Basis | Known figure | Status |
|---|---|---|---|
| Click-to-call minutes | Per minute, both legs billed | Plivo ₹0.40–0.60/min (published, inconsistent); others by quote | Get quotes |
| Virtual numbers | Monthly | Plivo ~₹250/month; others by quote | Get quotes |
| Per-seat telephony | Monthly | MyOperator ₹2,500/user/month (Growth, annual) | Verify current plan |
| WhatsApp template messages | Per delivered message by category (India market) | Not extracted | Get from BSP / Meta rate card |
| WhatsApp business-initiated calls | Per 6-second pulse | Not verified | Get from BSP |
| Recording storage | Our object storage | ~1 MB/min mp3 → 100 users × 60 min/day × 22 days ≈ 130 GB/month before retention | Estimate |

Example monthly cost for planning: 50 executives × 80 bridged calls/day × 2.5 min average × 22 days = 220,000 minutes. At ₹0.5–1.0/min across both legs, that is **≈ ₹1.1–2.2 lakh/month in minutes alone**. This is an assumption to replace with quotes. It is the main reason provider calling should be optional per org.

## 4. Regulatory constraints that shape calling design

(Details and sources in compliance notes.)
- **TRAI TCCCPR (2nd Amendment, Feb 2025):** promotional calls must come from the **140-series** via registered senders. Unregistered senders using normal 10-digit numbers for telemarketing risk **barring of outgoing services for 15 days and then disconnection of all their telecom resources for one year**. The 1600-series is mandated only for BFSI and government (TRAI PR 91/2026). → The CRM must **not** offer bulk/auto dialling from personal SIMs, and must surface consent/DND status before calls.
- **CNAP** (caller name presentation) default-on for 4G+ from 1 Nov 2026 *(secondary news of DoT circular)*. Register the brokerage's name with the provider/operator so bridged calls show the business name.
- **Media anchoring:** both legs must stay in India (Plivo docs), which rules out foreign-number solutions.
- **Recording:** no explicit Indian statute requiring all-party consent was found (NEEDS-LEGAL-REVIEW). A recording is personal data under DPDP. Design: announcement + notice + restricted access + retention limits, and enabled only after the org confirms legal review.

## 5. Proof-of-concept plan (before Phase 6 build)

| PoC | Goal | Pass criteria |
|---|---|---|
| PoC-1 Exotel/Smartflo click-to-call | Agent-first bridge from a CRM button, webhooks to a staging endpoint | Call connects < 10 s; webhook for answered + completed received with our correlation id in ≥ 99% of 200 test calls; duration matches handset ± 2 s; recording retrievable |
| PoC-2 Webhook reliability | Replay, duplicate and out-of-order handling | Duplicate delivery produces one Interaction; out-of-order events end in the correct final state |
| PoC-3 WhatsApp Cloud API messaging | Template send + status webhooks via chosen BSP | Signature validation; delivery statuses; opt-in check enforced |
| PoC-4 WhatsApp Calling (business-initiated, +91 number) | Prove India availability and permission flow; WebRTC softphone on Android Chrome 4G | Permission granted by a test user; call connects with acceptable audio (MOS ≥ 3.5 subjective); terminate webhook carries duration |
| PoC-5 CNAP/caller ID | Business name shows on recipient handsets | Name displayed on ≥ 3 of 4 operators tested |

## 6. Sources (accessed 2026-10-19)

- MDN `<a>` / tel: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a · RFC 3966: https://datatracker.ietf.org/doc/html/rfc3966 · Apple Phone Links: https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/PhoneLinks/PhoneLinks.html
- WhatsApp Click to Chat: https://faq.whatsapp.com/5913398998672934
- Meta Calling API overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/ · business-initiated: …/calling/business-initiated-calls · user-initiated: …/calling/user-initiated-calls · permissions: …/calling/user-call-permissions · buttons/deep links: …/calling/call-button-messages-deep-links/ · recording: …/calling/call-recording/ · pricing: …/calling/pricing/
- WhatsApp messaging pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing · sending/service window: …/messages/send-messages · opt-in: …/getting-opt-in · webhooks/signature: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- Twilio WhatsApp Business Calling: https://www.twilio.com/docs/voice/whatsapp-business-calling · Twilio India voice guidelines: https://www.twilio.com/en-us/guidelines/in/voice
- Infobip business-initiated calling: https://support.infobip.com/docs/whatsapp/whatsapp-business-calling/business-initiated-calling
- Exotel connect API: https://developer.exotel.com/api/make-a-call-api · Exotel WhatsApp calling beta: https://exotel.com/blog/introducing-whatsapp-business-calling-api-beta/ · pricing: https://exotel.com/pricing/
- Smartflo click-to-call: https://docs.smartflo.tatatelebusiness.com/reference/v1click_to_call-1 · webhooks: https://docs.smartflo.tatatelebusiness.com/docs/webhook
- Ozonetel callbacks: https://docs.ozonetel.com/docs/callback-url-config · *(secondary)* LeadSquared Ozonetel: https://help.leadsquared.com/mobile-cloud-calling-set-up-for-ozonetel-cloud-agent/
- MyOperator webhooks: https://support.myoperator.com/portal/en/kb/articles/how-do-i-set-up-and-manage-myoperator-calling-webhooks · pricing: https://myoperator.com/india-pricing
- Plivo India calling: https://docs.plivo.com/docs/voice/concepts/india-calling · pricing: https://www.plivo.com/voice/pricing/in/
- *(secondary)* Knowlarity via Corefactors: https://www.corefactors.in/integrations/knowlarity/index
- TRAI PR 11/2025: https://trai.gov.in/sites/default/files/2025-02/PR_No.11of2025.pdf · TRAI PR 91/2026: https://trai.gov.in/sites/default/files/2026-07/PR_No91of2026.pdf
- *(secondary)* CNAP: https://inc42.com/buzz/centre-directs-telcos-to-display-caller-names-from-november-1/
