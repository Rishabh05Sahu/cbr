# ADR-0021: Property inventory and confidential owner contacts (FR-140, FR-142)

- **Status:** Accepted by the owner on 2026-10-30 for local engineering completion (focused tests and browser checks). Implemented locally (uncommitted).
- **Date:** 2026-10-30
- **Builds on:** [ADR-0004](ADR-0004-multi-tenancy-and-permissions.md), [ADR-0011](ADR-0011-call-scripts.md) (role policies, "cfg" handling). Migration `0025_properties`.

## Context
Phase 5 begins with property inventory:
- **FR-140** (Must, no dependency): "Property CRUD with fields from domain model (listing, location, price, type, area, amenities, owner contact, status, responsible agent)".
- **FR-142** (Must): "Owner contact is confidential (separate permission)".
- **Domain model §2.7:** defines `Property` and a separate, restricted `PropertyContact` ("Audit: every read via UI reveal + changes").
- **Role matrix §4.5:** sets the permissions.

FR-140 is the foundation for FR-141, 143, 144, 153 and 157, so it comes first. Its "owner contact" field is only safe with FR-142's protection, so both are built together.

## Decisions

| # | Decision | Source / why | Evidence |
|---|---|---|---|
| 1 | **Fields** as domain model §2.7: title, listing type (Sale, Rent, Lease), property type (the lead's codes, for FR-143 matching), BHK, city, locality, address, optional lat/lng, price numeric(15,2) with basis (Total / Per sq ft / Per month), maintenance, deposit, carpet and built-up area, floor, facing, furnishing, amenities (≤ 30), status, responsible agent, available from, and a description. | Domain model | Migration 0025; integration |
| 2 | **Not built:** `project_id` and RERA fields (OD-07 and OD-10 are open), media (FR-141), geo search. | Open decisions; later FRs | — |
| 3 | **Code:** org-unique, `P-00001` upwards, assigned in sequence under a per-org transaction lock (concurrent creates get distinct codes). It never changes. | Domain model ("org-unique human id, e.g. CBR-P-00123"; the org prefix is not specified, so `P-` is used) | `property_guard`; integration (5 concurrent) |
| 4 | **Consistency rules:** a sale is priced in total or per sq ft and can be Sold; rent and lease are priced per month and can be Rented; a deposit only applies to rent and lease. | Meaning of the listing types (no separate requirement) | CHECKs + `listingProblems`; unit + integration |
| 5 | **Status:** Draft (default), Available, On hold, Sold, Rented, Withdrawn. Any change is allowed (no workflow is specified) and audited with from/to. **No delete:** Withdrawn takes a listing off the market (status-based close, database design). | Domain model; audit "status/price changes" | Grants (no DELETE); integration |
| 6 | **Permissions** (§4.5): `property.read` for Owner, Admin, Sales Manager and Sales Executive (all properties, non-confidential fields); `property.manage` for Owner and Admin; `property.read_owner_contact` for Owner, Admin and Sales Manager. Sales Manager "manage" and Sales Executive "manage own listings" / "owner contact (own listings)" are **cfg**: off until an org setting exists, as for `script.manage` (ADR-0011). HR has none. RESTRICTIVE role policies enforce the same in the database. | Role matrix | `permissions.ts` + tests; DB checks as `crm_app` |
| 7 | **Responsible agent:** an active Owner, Admin, Sales Manager or Sales Executive of the org (default: the creator). | FR-140 | Integration |
| 8 | **Edits:** optimistic version. The audit names the changed fields, plus status and price from/to. An edit that changes nothing writes nothing. | Database design §5; domain audit | Integration |
| 9 | **Owner contacts (FR-142):** `property_contact` (name, Indian mobile in E.164 and/or email, relationship Owner / Authorised agent / Developer). They are **never part of a property read**. They are returned only by an explicit "Show contacts" (`revealContacts`), which writes `property.contacts_viewed` each time (who, which property, how many; never the contact data). Added by Owner/Admin; removed (recorded), never edited or deleted. No call or message links (G5). | FR-142; domain model "every read via UI reveal" | Integration (SE/HR refused, audit content, no data in reads or audit); DB: SE sees 0 rows |
| 10 | **List:** filters for status, listing type, property type, city (case-insensitive), price range and BHK, plus a search over code, title and locality. Newest first, 50 per page. Invalid filter values are ignored. | FR-140 | Integration |
| 11 | **UI:** "Properties" in the navigation for `property.read`; list with filters; Add property and Edit (Owner/Admin); an "Owner contacts" panel (Confidential) for Owner/Admin/SM. Rupee amounts are shown in Indian grouping (₹85,00,000). | Mobile-first | Browser check at 390×844 and 1440×900 |

## Owner decisions (2026-10-30, on acceptance)
- **Creating and editing** properties stay Owner/Admin only. Sales Manager editing is not enabled without an approved organisation-setting requirement.
- **Sales Executives** stay read-only for properties, including listings where they are the responsible agent. They cannot manage property records or reveal owner contacts.
- **Owner contacts** stay visible only to Owner, Admin and Sales Manager, with every reveal logged.
- **Codes:** the organisation-scoped `P-00001` format stays; existing listings are not renumbered. FR-140's own wording ("Property CRUD with fields from domain model") does not require a prefix. Only the domain model's example code `CBR-P-00123` suggests an organisation-specific prefix: **this discrepancy is recorded for review.**
- **OD-07 (projects) and OD-10 (RERA)** stay open; neither is built.

## Known limitations
- No media or documents (FR-141), no matching (FR-143), no share links (FR-144), no deals (FR-153), no property-linked visits (FR-157).
- No status workflow, availability calendar or duplicate-listing detection.
- The list pages by offset (adequate for inventory sizes; leads use cursors).
