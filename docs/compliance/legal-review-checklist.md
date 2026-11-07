# Legal Review Checklist for Qualified Counsel (India)

> **What this is:** a list of questions and facts prepared by the engineering team for a qualified Indian lawyer. **It is not legal advice and it is not legal approval.** Nothing here has been reviewed by counsel yet.
> **Status (2026-10-20):** **all items OPEN.** Gate G5 blocks the use of real brokerage customer data until counsel has answered the items marked **Blocking** and the owner has accepted the advice in writing.
> **Background for counsel:**
> - [compliance-and-regulatory-notes.md](../architecture/compliance-and-regulatory-notes.md): engineering summary with sources, each point labelled CONFIRMED or NEEDS-LEGAL-REVIEW.
> - [calling-and-whatsapp-research.md](../architecture/calling-and-whatsapp-research.md): what calling and WhatsApp can technically do.
>
> **Product context:** CBR Property CRM is a multi-tenant SaaS for Indian real-estate brokerages. Each brokerage (tenant) stores its leads (buyers, tenants, owners), property listings, follow-ups and call/WhatsApp activity. Sales executives call leads, today often from their own mobile phones. CBR operates the software and hosting (India region) and sees tenant data only through an Owner-approved, time-limited, audited support grant.

## How to use this checklist

For each item, counsel records:
- the **answer / advice**;
- **conditions** (what we must build, write or stop doing);
- the **source** (statute, rule, circular, case);
- whether the item **blocks the pilot**.

Engineering then converts the conditions into requirements, and the owner signs off. Column *Our current design* shows what is built or planned today, so counsel can say what must change.

## A. Commercial calling and telemarketing (TRAI TCCCPR 2018, 2nd Amendment 2025)

| # | Question for counsel | Our current design | Blocking? |
|---|---|---|---|
| A1 | When a brokerage's salesperson calls a person who **enquired about a property** (portal enquiry, website form, walk-in), is that call **promotional**, **service** or **transactional** under TCCCPR? Does the answer change if the call is a follow-up weeks later, or offers *other* properties? | The UI will show each lead's source and recorded basis before a call (Phase 3) | **Yes** |
| A2 | Which kinds of call need **explicit digital consent** (per TCCCPR's Consent Registration Function), and what does a valid record of it look like (time, purpose, channel, validity such as 7 days for ongoing-transaction service calls)? | `ConsentRecord` planned (Phase 2–3): purpose, channel, timestamp, source, evidence reference | **Yes** |
| A3 | Must brokerages **scrub against DND / customer preference registration** before calling enquiring leads? If so, can the CRM rely on the brokerage's attestation, or must it check itself (and via which access)? | Not built. Planned: per-lead `contact_status` + org policy | **Yes** |
| A4 | Does the 140-series requirement for promotional voice calls apply to **one-to-one calls by an individual salesperson**, or only to bulk/automated campaigns? | The CRM offers **no** bulk dialling, auto-dialling or robocalls | **Yes** |
| A5 | What **liability** do CBR (software provider) and the brokerage carry if a salesperson's calls lead to UCC complaints, number barring or blacklisting? Can CBR limit its liability contractually? | Terms of service not drafted | Yes (for terms) |
| A6 | Are **CNAP** (caller name presentation) rules relevant to how brokerages should register their business name with telephony providers? | Noted for Phase 6 | No |

## B. Personal SIMs versus approved telephony systems

| # | Question for counsel | Our current design | Blocking? |
|---|---|---|---|
| B1 | Is it lawful for a salesperson to call leads from a **personal SIM** at all? Under what conditions (consent, call type, frequency)? | Phase 3 "Call" button only opens the phone's dialer (`tel:`); the CRM records the tap, not the call | **Yes** |
| B2 | Should the CRM **allow an organisation to forbid personal-SIM calling** (policy setting) or **require** a registered telephony provider (e.g. Exotel, Tata Tele Smartflo click-to-call from a registered business number) above some volume? | Org policy setting planned; provider calling planned for Phase 6 | No (design input) |
| B3 | If a brokerage provides **company SIMs** to staff, does that change the analysis versus personal SIMs? | — | No |
| B4 | Employment angle: may the brokerage **monitor or log** calls made from an employee's personal phone (we only log taps and manual notes)? What notice to employees is needed? | Only taps + manual logs; no device access | Yes (notice wording) |
| B5 | With a **cloud telephony provider**, who is the "sender" / principal entity for TRAI purposes: the brokerage, CBR or the provider? What registrations does each need (entity, headers, numbers)? | Brokerage as customer of the provider is the working assumption | No (Phase 6) |

## C. Consent, contact preferences and opt-out

| # | Question for counsel | Our current design | Blocking? |
|---|---|---|---|
| C1 | For leads that came from **property portals, purchased lists, referrals or imports**, what **lawful basis** under the DPDP Act applies? Is s.7(a) "voluntarily provided for a specified purpose" enough? The Act's own illustration is a real-estate broker. | Each lead records `source` and `basis`. The import flow will require an **attestation** by the importing user (wording needed from counsel) | **Yes** |
| C2 | What **notice** must the brokerage give a lead (content, language, timing), and can the CRM provide a template? | Not built; notice templates planned | **Yes** (before DPDP Rule 3 commencement ~May 2027; recommended for pilot) |
| C3 | How must **"stop contacting me"** be honoured across channels (call, WhatsApp, SMS, email), and how quickly? | Planned: one `contact_status` per lead that blocks all outbound launchers, effective immediately, audited | **Yes** |
| C4 | How do we evidence **withdrawal of consent** and propagate it to processors (s.6(6))? | Withdrawal is recorded and blocks future sends; integrations receive no further sends | No (design check) |
| C5 | Is a **brokerage-wide** opt-out enough, or must opt-outs be shared across brokerages on the platform? (We assume **not**: tenants are isolated) | Tenant-isolated (no cross-tenant data use) | No |

## D. Call recording, access and retention

| # | Question for counsel | Our current design | Blocking? |
|---|---|---|---|
| D1 | Is **one-party** recording (by the brokerage) lawful for business calls in India, or is **all-party consent** needed? Is an **announcement** at call start sufficient? | Recording **off by default**. Enabling needs the Owner to confirm legal review and configure an announcement (Phase 6) | Yes (before enabling recording) |
| D2 | Who may **listen** to recordings (manager, admin, HR), and must access be logged? | Restricted access, audited playback (planned) | No (design check) |
| D3 | **Retention:** what is the maximum/minimum period? How does erasure on request interact with DPDP Rule 8(3) (1-year retention of certain data and logs)? | Default 90 days, configurable; "legal hold" tier planned | Yes (before enabling recording) |
| D4 | Are recordings of WhatsApp calls (Meta plays an announcement) treated the same as telephony recordings? | Phase 6 | No |

## E. WhatsApp Business communication and calling

| # | Question for counsel | Our current design | Blocking? |
|---|---|---|---|
| E1 | Beyond Meta's WhatsApp Business Messaging Policy (opt-in, honour opt-out), do **TRAI/DoT rules** (DLT, TCCCPR) apply to WhatsApp messages from businesses? | No such instrument found (NEEDS-LEGAL-REVIEW) | No (Phase 6) |
| E2 | Is a salesperson sending WhatsApp messages from their **personal WhatsApp** to leads a compliance risk we must discourage or block in the product? | Phase 3 WhatsApp button only opens `wa.me` chat; no automation | Yes (product stance) |
| E3 | For **business-initiated WhatsApp calls** (Cloud API Calling), Meta requires a user call-permission request. Is that permission sufficient consent for Indian law, or is more needed? | Phase 6 PoC | No |
| E4 | Which party (brokerage, CBR, BSP) is the business of record, and what must the brokerage's WhatsApp profile disclose? | — | No |

## F. Privacy, customer-data processing and retention (DPDP Act 2023, DPDP Rules 2025)

| # | Question for counsel | Our current design | Blocking? |
|---|---|---|---|
| F1 | Confirm the roles: brokerage = **Data Fiduciary**; CBR = **Data Processor**. What must CBR avoid so it stays a processor (e.g. no cross-tenant analytics, no model training on tenant data)? | No cross-tenant use; tenant isolation enforced in the database (RLS, tested) | **Yes** |
| F2 | Is a **Significant Data Fiduciary** notification likely for brokerages or CBR? | Monitor | No |
| F3 | **Breach notification:** the Fiduciary must notify the Board and principals; what **contractual window** should CBR commit to towards the brokerage? We propose ≤ 24 h | Incident runbook; CERT-In 6 h reporting also applies to CBR as a body corporate | **Yes** (DPA clause) |
| F4 | **Retention and erasure:** default retention for leads that never converted? How to reconcile erasure with Rule 8(3) one-year retention and CERT-In's 180-day log retention? | Configurable retention (FR-172); logs kept 1 year in India | **Yes** |
| F5 | **Data-principal rights** (access, correction, erasure, grievance ≤ 90 days, nomination): what must the brokerage provide, and what tooling must CBR give them? | FR-171 tooling planned | No (pilot: manual process acceptable?) |
| F6 | **Commencement dates:** confirm which DPDP provisions apply at pilot start (Oct 2026–2027) versus May 2027, and whether a shortening of the transition is in force | Engineering read: most duties from ~13 May 2027 (Rules); Act commencement read via secondary source | **Yes** |
| F7 | **Cross-border:** hosting is India (DigitalOcean Bengaluru, AWS Mumbai for email). Are sub-processors outside India acceptable, e.g. error tracking (Sentry, US) receiving scrubbed error data? | Error events are scrubbed of personal data; sub-processor list to be published | No (confirm) |
| F8 | **Employee data** (staff names, phones, HR fields in the CRM): any separate obligations? | HR fields limited to employee code/designation in Phase 1 | No |
| F9 | **CERT-In:** is a vertical SaaS CRM a "cloud service provider" with 5-year subscriber KYC duties? | Assumed not (IaaS/PaaS reading) | No (confirm) |
| F10 | **RERA:** state rules for agents' record-keeping, quarterly uploads and advertisements (registration number/QR). Which must the CRM support for the pilot state (OD-14)? | Phase 5 | No |

## G. Vendor contracts and data-processing responsibilities

| # | Question / document | Status | Blocking? |
|---|---|---|---|
| G1 | **Data Processing Agreement (DPA)** between CBR and each brokerage: processor duties, instructions, confidentiality, security measures (Rule 6), breach window, sub-processors (list + change notice), audits, return/erasure at end, Rule 8(3) holds | **Not drafted** | **Yes** |
| G2 | **Terms of Service / Master Subscription Agreement**: acceptable use (no bulk unsolicited calling, no purchased lists without lawful basis), liability caps, indemnities for UCC violations by tenant staff, suspension rights | **Not drafted** | **Yes** |
| G3 | **Sub-processor contracts:** check each provider's DPA/terms. They are DigitalOcean (hosting, India region), AWS (SES email, Mumbai), Sentry (errors, if used), and later the telephony provider, WhatsApp BSP/Meta, and any SMS DLT provider | Provider standard DPAs not yet reviewed | **Yes** (hosting + email) |
| G4 | **Import attestation** wording: text a brokerage user must accept when importing leads (source, lawful basis, notice given) | Needs wording from counsel | **Yes** (before any import) |
| G5 | **Privacy notice** for the CRM's own users (brokerage staff), and cookie notice (only essential cookies are used) | Not drafted | Yes |
| G6 | **Support access:** confirm the Owner-approved, time-boxed, read-only support grant is an acceptable processor practice and how it should be described in the DPA | Built and audited (Phase 1) | No (confirm) |

## H. Unresolved questions (explicit list)

The following are **unresolved**, and engineering cannot resolve them without counsel:

1. **A1/A4/B1:** whether one-to-one calls from personal SIMs to enquiring leads are lawful and under which call category.
2. **A2/A3:** whether DND / preference scrubbing or explicit digital consent is required for those calls, and what record proves it.
3. **C1/G4:** lawful basis for portal, purchased and imported leads, and the attestation wording.
4. **D1/D3:** recording consent model, announcement wording and retention bounds.
5. **E1/E2:** whether TRAI rules reach WhatsApp business messaging, and the product stance on personal-WhatsApp messaging.
6. **F1/F3/F4/F6:** processor status, breach-notice window, retention/erasure versus Rule 8(3), and which DPDP duties apply at pilot start.
7. **G1/G2/G3:** DPA, terms and sub-processor review. These **must exist before the first brokerage's real data is loaded.**
8. **F10:** RERA requirements for the pilot state. The state depends on OD-14 (pilot brokerage not yet named).

## I. Sign-off record (to be completed)

| Item group | Counsel (name, firm) | Date | Advice reference | Owner acceptance |
|---|---|---|---|---|
| A–B Calling | | | | |
| C Consent | | | | |
| D Recording | | | | |
| E WhatsApp | | | | |
| F Privacy | | | | |
| G Contracts | | | | |

**Until the Blocking items have counsel's answers and the owner's acceptance, only synthetic or anonymised data may be used.**
