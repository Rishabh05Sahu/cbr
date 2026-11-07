# ADR-0006: Launch-first calling, provider adapters later, evidence levels kept separate

- **Status:** Proposed
- **Date:** 2026-10-19

## Context
Salespeople must call by phone and WhatsApp from the lead page. Research ([calling-and-whatsapp-research.md](../calling-and-whatsapp-research.md)) shows:
- a web page cannot observe calls made through `tel:` or the WhatsApp app;
- no link can start a WhatsApp call to an arbitrary lead;
- WhatsApp business-initiated calling needs a Cloud API number with a ≥ 2,000/day messaging limit, user call permission and our own WebRTC/SIP endpoint, and its India availability is inferred rather than confirmed;
- Indian cloud telephony (Exotel, Smartflo) offers click-to-call bridging with webhooks and recording;
- Twilio cannot do domestic Indian calling;
- TRAI rules make bulk calling from personal SIMs risky.

## Decision
1. **Phase 3:** "Call" = `tel:` launcher; "WhatsApp" = `wa.me` launcher. Each tap records a **CallIntent (L0)** only. Outcomes are logged manually (L1) with a post-call prompt.
2. **Phase 6:** a `TelephonyProvider` port with one Indian provider adapter (shortlist Exotel, Smartflo) for agent-first bridged calls, status webhooks (L2/L3), duration and optional recording. Gated by PoCs and legal review.
3. **WhatsApp messaging** via the Cloud API (direct or BSP) in Phase 6. **WhatsApp business calling** only if PoC-4 proves availability for our +91 number and acceptable mobile WebRTC quality. Feature-flagged per org.
4. Evidence levels (L0 click, L1 manual, L2 provider attempt, L3 connected, L4 conversation) stay distinct in data and KPIs. **Missing data is never fabricated.**
5. No auto-dialler or bulk-calling feature.

## Alternatives considered
| Alternative | Why not now |
|---|---|
| Provider calling from day one | Cost (≈ ₹1–2 lakh/month at base assumptions), contracts/KYC lead time, legal review pending; MVP value doesn't depend on it |
| Native Android app reading the device call log | Out of scope (no native apps); Play Store call-log permission policy restrictions (not verified); privacy concerns about personal calls |
| WhatsApp Calling API first | Prerequisites (messaging tier, permission flow, WebRTC softphone) and India availability unconfirmed |

## Consequences
- (+) MVP ships without telecom dependencies. Data honesty is preserved.
- (−) Phase 3 calling KPIs are self-reported. Dashboards label them clearly.
- Security: provider credentials stay server-side and encrypted per org. Webhooks are verified, deduplicated and reconciled.

## Reconsider when
A provider offers a reliable mobile SDK or app integration with event webhooks that fits executives' workflow; Meta confirms India business-initiated calling and the PoC passes; regulation changes.

## References
See the sources list in calling-and-whatsapp-research.md §6 (Meta Calling API docs, Exotel/Smartflo API docs, Twilio India guidelines, TRAI PR 11/2025 and 91/2026).
