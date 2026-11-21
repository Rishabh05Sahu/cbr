# ADR-0026: Property photos (FR-141)

- **Status:** Implemented on 2026-11-19 at the owner's request ("in add property section we can also upload property related photos"). Migration `0030_property_photos` applied to local `crm_dev` and `crm_test` after verified backups; pinned for Supabase in `scripts/db/migrate-supabase.mjs` (owner approved 2026-11-19), applied there by the owner.
- **Date:** 2026-11-19
- **Builds on:** ADR-0021 (property inventory, role matrix §4.5), M4 storage (private bucket, server-issued keys), FR-141.

## Context
FR-141 asks for property photos (≤ 20 per property, ≤ 10 MB each, JPEG/PNG/WebP, thumbnails) with EXIF location data stripped. Documents (PDF) are part of FR-141 but were not requested now. The pilot runs on a small EC2 instance (ADR-0024) and the test site on Vercel (4.5 MB request limit); users are on phones in Dubai.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Who:** Owner and Admin add and remove photos (`property.manage`); Owner, Admin, Sales Manager and Sales Executive see them (`property.read`); HR none. Enforced in the module and by RESTRICTIVE RLS policies on `property_photo`. | Same as properties (ADR-0021: manage = Owner/Admin) |
| 2 | **Prepared in the browser:** each photo is decoded the right way up and re-drawn on a canvas (≤ 2048 px, plus a ≤ 480 px thumbnail), encoded as WebP, or JPEG where the browser cannot write WebP. Re-drawing drops every EXIF/XMP block, so **location data never leaves the device**. | Small uploads on mobile data; fits the Vercel limit; no image library on the server (adding `sharp` needed a registry download) |
| 3 | **The server never decodes an image.** `photo-format.ts` checks the container only: JPEG or still WebP; no EXIF/XMP/IPTC/comment blocks (refused, not stripped); no animation; no bytes after the image; sides ≤ 4096 px (thumbnail ≤ 640); size ≤ 10 MB (thumbnail ≤ 1 MB). Photo and thumbnail must be the same type. | Decoding untrusted images is the riskier step; refusing anything unexplained is simpler to reason about |
| 4 | **Upload:** `POST /app/properties/<id>/photos`, multipart `photo` + `thumb`, one photo per request. Same-origin only (the Origin's host must be the server's host; route handlers have no built-in check), `Content-Length` required and capped before parsing. | Server Actions have a 1 MB body limit; one photo per request keeps memory flat |
| 5 | **Storage:** the existing private bucket, under `orgs/<org>/property-photos/<property>/<128 random bits>.<jpg|webp>`; the database checks every key names the photo's own org and property. | No new bucket to provision; cleanup and serving can trust the key |
| 6 | **Serving:** `GET /app/properties/<id>/photos/<photoId>[?size=thumb]` streams the file after the permission check, `private, no-store`, `nosniff`. No storage URL reaches a browser. | Photos of a private inventory stay private |
| 7 | **At most 20 photos** per property: checked in the app under a per-property lock, and by a database trigger under the same lock. | FR-141; concurrent uploads cannot exceed it |
| 8 | **Removal is recorded** (`removed_at`, `removed_by`), never deleted; the files are deleted from storage after the commit (a failure leaves an unreferenced file, never a broken photo). Audit: `property.photo_added`, `property.photo_removed`. | Same as owner contacts |
| 9 | **Add property with photos:** photos chosen on the Add property form are uploaded right after the property is saved (the action returns the new id instead of redirecting), then its page opens. Failed photos are reported there. | One step for the user; the property is never saved twice |
| 10 | The first photo (oldest) is the cover. | Simplest rule; reordering is not built |

## Limitations and follow-ups
- **Hosted bucket:** the Supabase bucket must allow `image/jpeg` and `image/webp` (runbook `supabase-storage-setup.md` §2), or uploads fail with a storage error.
- **Storage space:** Supabase Free has 1 GB. A prepared photo is roughly 150–500 KB, so about 2,000–6,000 photos fit, shared with import and export files.
- **Not built:** documents (PDF), reordering or choosing a cover, captions, sharing (FR-144), a cover thumbnail on the property list.
- **Browsers:** verified with Chrome (its canvas WebP and JPEG output pass the server check). Safari/iPhone not verified on a device; older Safari sends JPEG. HEIC files open only where the browser can decode them (Safari converts them when picked from Photos).
- The server trusts nothing in the file but does not check that the pixels decode; a corrupt but well-formed file would show as a broken image to the people who can see the property.

## Tests
Unit `photo-format.test.ts` (each JPEG/WebP rule, built byte by byte), storage key tests; integration `property-photos.test.ts` (roles, EXIF refused, removal, limit in app and database, other orgs, crm_app backstop); e2e `property-photos.test.ts` (real multipart uploads, cross-site refusal, roles, size cap, private headers, serving).
