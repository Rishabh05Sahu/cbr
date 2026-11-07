# Compliance and Regulatory Notes (India)

> **This is an engineering summary, not a legal opinion.** Date verified: **2026-10-19**. Each item is labelled **CONFIRMED** (read in an official instrument or regulator document) or **NEEDS-LEGAL-REVIEW**. A qualified Indian lawyer must review the NEEDS-LEGAL-REVIEW items before the pilot (risk R-03).

## 1. Digital Personal Data Protection Act, 2023 and DPDP Rules, 2025

| Topic | Summary | Status | Architecture impact |
|---|---|---|---|
| Rules notified | G.S.R. 846(E), gazette dated 13 Nov 2025 | CONFIRMED | — |
| Phased commencement | Board provisions immediately; Rule 4 (Consent Managers) ~13 Nov 2026; Rules 3, 5–16, 22–23 (notice, security, breach, retention, rights, cross-border) ~**13 May 2027** | CONFIRMED (Rules); Act commencement notification G.S.R. 843(E) read only via secondary source → NEEDS-LEGAL-REVIEW. Reports of a proposal to shorten to 12 months; no amendment found | **Design for compliance readiness by Phase 4 (well before May 2027).** Re-check the gazette at each phase gate |
| Roles | Brokerage (tenant) = **Data Fiduciary**; CBR as SaaS = **Data Processor**, engaged only under a valid contract (s.8(2)); the Fiduciary stays responsible (s.8(1)) | CONFIRMED definitions; our status as pure processor depends on not using tenant data for our own purposes → NEEDS-LEGAL-REVIEW | **No cross-tenant use of lead data, no training of models on tenant data without contract + opt-in.** A Data Processing Agreement is needed before the pilot |
| Legitimate use | s.7(a) lets data the principal voluntarily provided for a purpose be processed for that purpose. The Act's illustration is **a real-estate broker sending matching listings** to someone who asked for rental help, who must stop when told | CONFIRMED (text); coverage of purchased/portal leads → NEEDS-LEGAL-REVIEW | Record `basis` and source on each lead/enquiry; honour "stop" immediately (contact_status) |
| Notice & consent withdrawal | Itemised notice; withdrawal as easy as giving consent; Fiduciary must make its Processors cease processing (s.6(6)) | CONFIRMED | ConsentRecord model; withdrawal propagates to integrations (no further sends) |
| Security safeguards | Rule 6: encryption/masking, access control, **access logs + monitoring**, backups/continuity, **retain logs for one year**, contract clause between Fiduciary and Processor | CONFIRMED | Matches our controls; **log retention ≥ 1 year** (NFR-053/080) |
| Breach notification | To each affected principal without delay; to the Board without delay and a detailed report **within 72 hours** | CONFIRMED (Fiduciary duty). Processor → Fiduciary deadline is contractual → NEEDS-LEGAL-REVIEW | Incident runbook; we notify tenants within a contractual window (proposed ≤ 24 h) with the data needed for their report |
| Retention | Erase when the purpose is served or consent is withdrawn (s.8(7)), and cause processors to erase; Rule 8(3): keep personal data, traffic data and logs for **at least one year** for specified State purposes | CONFIRMED; reconciling erasure with the 1-year hold → NEEDS-LEGAL-REVIEW | Erasure workflow with an optional restricted "legal hold" tier; configurable retention (FR-172) |
| Rights | Access, correction, completion, erasure, grievance, nomination; grievance response ≤ 90 days | CONFIRMED | FR-171 tooling for tenants |
| Significant Data Fiduciary | By government notification; extra duties, possible localisation | CONFIRMED mechanism; no notification covering brokerages found | Monitor |
| Cross-border transfer | Allowed except to notified restricted countries (none found) | CONFIRMED mechanism | Host in India by default anyway (NFR-051); sub-processor list per region |
| Penalties | Up to ₹250 crore (security safeguards failure), ₹200 crore (breach notice failure) | CONFIRMED | Justifies security investment |

## 2. TRAI TCCCPR 2018 as amended (2nd Amendment, 12 Feb 2025)

| Topic | Summary | Status | Impact |
|---|---|---|---|
| Categories | Promotional (needs DND allowance or explicit digital consent; opt-out); Service (existing customer info; ongoing-transaction calls need explicit consent valid 7 days); Transactional (within 30 min of customer transaction) | CONFIRMED | Store consent with timestamps and purpose |
| Numbering | Commercial communication only from registered headers or special series. **140-series mandatory for promotional calls by any sector**; 1600-series mandated for BFSI and government (TRAI PR 91/2026) | CONFIRMED | No bulk/promotional calling features using personal SIMs |
| UTM consequences | Unregistered senders: 5 complaints in 10 days → outgoing barred 15 days; repeat → disconnection of **all** telecom resources across operators for 1 year + blacklisting | CONFIRMED | Major business risk for brokerages whose executives cold-call from personal numbers. The CRM must not encourage it |
| Salespeople calling enquiring leads one-to-one from personal mobiles | Grey area: may be a service call with consent, or a response to the person's own request; no official guidance found | **NEEDS-LEGAL-REVIEW (high priority)** | Default UI shows consent/basis; org policy setting for whether personal-SIM calling is allowed; provider calling via a registered entity is the compliant path for scale |
| Auto-dialers | Senders must notify operators before robo-calls/auto-dialers | CONFIRMED | Out of scope |

## 3. Call recording

- No Indian statute found expressly requiring one-party or all-party consent for participant recording. Privacy is a fundamental right (*Puttaswamy*, 2017). Courts have been inconsistent on covert recordings. → **NEEDS-LEGAL-REVIEW**.
- A recording of an identifiable person is personal data under DPDP once the relevant provisions commence → notice, purpose limitation, security, retention.
- **Design:** recordings off by default; enabling requires the org owner to confirm legal review and configure an announcement; Meta's Calling API recording plays an announcement to both parties; restricted access, audited playback, retention 90 days default (subject to the Rule 8(3) one-year question).

## 4. SMS and WhatsApp

- **Commercial SMS: DLT registration** of entity, headers (suffixes -P/-S/-T/-G) and content templates; only whitelisted URLs/call-back numbers; opt-out in promotional SMS. CONFIRMED (TRAI directions). SMS is a Could feature. If built, store DLT entity/template/header ids per org.
- **WhatsApp:** governed by Meta's WhatsApp Business Messaging Policy: opt-in required, honour opt-outs. No TRAI/DoT instrument applying DLT to WhatsApp found → NEEDS-LEGAL-REVIEW. DPDP applies regardless.

## 5. RERA

- Real estate agents register under s.9 of the RERA Act, 2016 (state authorities). Conditions seen on an official HARERA certificate include maintaining books of account, records and documents per state rules, and **uploading transaction details quarterly**. CONFIRMED for Haryana; **rules vary by state** → NEEDS-LEGAL-REVIEW.
- MahaRERA reportedly requires the project registration number and QR code on agent advertisements *(secondary)*.
- **Design impact (Phase 5, OD-10):** store the org's agent RERA registration(s) per state with expiry; store project RERA ids/QR; include them in shared property pages/templates; provide a transaction export suitable for quarterly reporting.

## 6. CERT-In Directions (28 Apr 2022)

- Apply to service providers, intermediaries, data centres and **body corporates**. CONFIRMED.
- **Report specified incidents within 6 hours**; designate a point of contact; **sync clocks to NTP (NIC/NPL-traceable)**; **retain ICT logs 180 days rolling within Indian jurisdiction** (CERT-In FAQ Q35 allows storage abroad if logs can be produced promptly). CONFIRMED.
- Whether a vertical SaaS CRM is a "cloud service provider" subject to 5-year subscriber KYC duties → NEEDS-LEGAL-REVIEW (generally read as IaaS/PaaS).
- **Design:** logs retained 1 year (satisfies both); India-region log storage; incident runbook with the 6 h clock.

## 7. Data localisation

No general localisation requirement for this data under DPDP (CONFIRMED). No real-estate sectoral rule found (NEEDS-LEGAL-REVIEW). **Decision:** host data and logs in an Indian region by default (ADR-0007). This lowers CERT-In and future-notification risk and improves latency.

## 8. Items for legal review (priority order)

> The full question list for counsel, with blocking status and a sign-off record, is in [legal-review-checklist.md](../compliance/legal-review-checklist.md) (2026-10-20).


1. Personal-mobile calling to leads under TCCCPR, and the recommended consent capture (R-02).
2. DPA template: processor obligations, breach-notice window, sub-processors, erasure vs Rule 8(3).
3. Lawful basis for imported/portal/purchased leads; the import attestation wording.
4. Call recording consent model and retention.
5. State RERA record-keeping and advertisement rules for target states (start: Maharashtra, Karnataka, Haryana; **OD-14**).
6. CERT-In applicability details (KYC).

## Sources (accessed 2026-10-19)

- DPDP Rules 2025 (G.S.R. 846(E)): https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf
- DPDP Act 2023: https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf
- PIB backgrounder (17 Nov 2025): https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf
- TCCCPR 2nd Amendment 2025: https://trai.gov.in/sites/default/files/2025-02/Regulation_12022025.pdf · TRAI PR 11/2025: https://trai.gov.in/sites/default/files/2025-02/PR_No.11of2025.pdf · TRAI PR 91/2026: https://trai.gov.in/sites/default/files/2026-07/PR_No91of2026.pdf
- TRAI Direction 18 Nov 2025: https://www.trai.gov.in/sites/default/files/2025-11/Directions_18112025_0.PDF
- CERT-In Directions: https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf · FAQ: https://www.cert-in.org.in/PDF/FAQs_on_CyberSecurityDirections_May2022.pdf
- HARERA agent certificate example: https://haryanarera.gov.in/relation_cert/agent/RERA-GRG/agent_certificate/1778839978.pdf
- WhatsApp Business Messaging Policy: https://whatsappbusiness.com/policy/
- *(secondary)* DPDP commencement summary: https://dpdp.myndsolution.com/wiki/notifications/gsr-843e-2025-commencement/ · MahaRERA orders summary: https://old.wirc-icai.org/newsletters/2023/september/maharera.html
