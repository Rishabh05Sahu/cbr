// FR-141 property photos (migration 0030, ADR-0026). Owner/Admin add and remove (property.manage);
// everyone who reads properties sees them (property.read). Each upload is a photo and its
// thumbnail, both prepared in the browser and checked here structurally (./photo-format). Files go
// to private storage under orgs/<org>/property-photos/<property>/; a browser only ever receives
// them through loadPhoto, after the same permission check. A photo is removed (recorded), never
// deleted; its files are deleted from storage once the removal is committed.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { DomainError, notFound, ruleViolation } from '@/platform/errors';
import { logger } from '@/platform/observability/logger';
import { keyBelongsTo, objectKeyFor, type ObjectStorage } from '@/platform/storage';
import { inspectPhoto, PHOTO_EXT, PHOTO_LIMITS, type InspectedPhoto } from './photo-format';

export interface PhotoView {
  id: string;
  width: number;
  height: number;
  uploadedAt: Date;
  uploadedByName: string;
}

const uuid = z.uuid();
const parse = (id: string, what: string) => {
  const r = uuid.safeParse(id);
  if (!r.success) throw notFound(`${what} not found`);
  return r.data;
};
const invalid = (message: string) =>
  new DomainError('VALIDATION_FAILED', message, { photo: [message] });

/** Checks a photo and its thumbnail; both must be the same type. */
function inspectPair(full: Uint8Array, thumb: Uint8Array): InspectedPhoto {
  const f = inspectPhoto(full, { maxBytes: PHOTO_LIMITS.maxBytes, maxSide: PHOTO_LIMITS.maxSide });
  if (!f.ok) throw invalid(f.message);
  const t = inspectPhoto(thumb, {
    maxBytes: PHOTO_LIMITS.maxThumbBytes,
    maxSide: PHOTO_LIMITS.maxThumbSide,
  });
  if (!t.ok) throw invalid(`Thumbnail: ${t.message}`);
  if (t.value.type !== f.value.type)
    throw invalid('The thumbnail must be the same type as the photo');
  return f.value;
}

/** FR-141: adds one photo to a property (Owner/Admin). At most 20 photos per property. */
export async function addPhoto(
  ctx: RequestContext,
  propertyId: string,
  files: { full: Uint8Array; thumb: Uint8Array },
  deps: { storage: ObjectStorage },
): Promise<{ id: string }> {
  authorize(ctx, 'property.manage');
  if (ctx.kind !== 'member') throw notFound('Property not found');
  const pid = parse(propertyId, 'Property');
  const img = inspectPair(files.full, files.thumb);
  const ext = PHOTO_EXT[img.type];
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const property = await tx.property.findFirst({ where: { id: pid }, select: { id: true } });
    if (!property) throw notFound('Property not found');
    // Same lock as the database trigger, so the friendly message below is not raced.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'property_photo:' + pid}, 0))`;
    const count = await tx.propertyPhoto.count({ where: { propertyId: pid, removedAt: null } });
    if (count >= PHOTO_LIMITS.maxPhotos)
      throw ruleViolation(`A property can have at most ${PHOTO_LIMITS.maxPhotos} photos`);

    const storageKey = objectKeyFor(ctx.orgId, 'property-photos', pid, ext);
    const thumbKey = objectKeyFor(ctx.orgId, 'property-photos', pid, ext);
    await deps.storage.put(storageKey, files.full, img.type);
    try {
      await deps.storage.put(thumbKey, files.thumb, img.type);
      // now() in SQL: the RESTRICTIVE insert policy requires the transaction time exactly.
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO property_photo (org_id, property_id, storage_key, thumb_key, content_type,
          width, height, bytes, thumb_bytes, uploaded_by, uploaded_at)
        VALUES (${ctx.orgId}::uuid, ${pid}::uuid, ${storageKey}, ${thumbKey}, ${img.type},
          ${img.width}, ${img.height}, ${files.full.length}, ${files.thumb.length},
          ${ctx.userId}::uuid, now())
        RETURNING id`;
      await writeAudit(tx, ctx.orgId, {
        action: 'property.photo_added',
        entityType: 'property',
        entityId: pid,
        actorUserId: ctx.userId,
        metadata: { photoId: row!.id, width: img.width, height: img.height },
      });
      return { id: row!.id };
    } catch (e) {
      // Nothing was recorded: the stored files are not referenced by anything.
      await deps.storage.remove([storageKey, thumbKey]).catch((err: unknown) => {
        logger.warn({ err }, 'property photo: files of a failed upload were not removed');
      });
      throw e;
    }
  });
}

/** FR-141: a property's photos, oldest first (the first is the cover). Needs property.read. */
export async function listPhotos(ctx: RequestContext, propertyId: string): Promise<PhotoView[]> {
  authorize(ctx, 'property.read');
  const pid = parse(propertyId, 'Property');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.propertyPhoto.findMany({
      where: { propertyId: pid, removedAt: null },
      orderBy: [{ uploadedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        width: true,
        height: true,
        uploadedAt: true,
        uploader: { select: { user: { select: { name: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      width: r.width,
      height: r.height,
      uploadedAt: r.uploadedAt,
      uploadedByName: r.uploader.user.name,
    }));
  });
}

/**
 * FR-141: one photo's bytes for the app to stream (needs property.read). Removed photos, other
 * properties and other orgs are all "not found".
 */
export async function loadPhoto(
  ctx: RequestContext,
  propertyId: string,
  photoId: string,
  size: 'full' | 'thumb',
  deps: { storage: ObjectStorage },
): Promise<{ body: Uint8Array; contentType: string }> {
  authorize(ctx, 'property.read');
  const pid = parse(propertyId, 'Photo');
  const id = parse(photoId, 'Photo');
  const row = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.propertyPhoto.findFirst({
      where: { id, propertyId: pid, removedAt: null },
      select: { storageKey: true, thumbKey: true, contentType: true },
    }),
  );
  if (!row) throw notFound('Photo not found');
  const key = size === 'thumb' ? row.thumbKey : row.storageKey;
  if (!keyBelongsTo(key, ctx.orgId, 'property-photos', pid)) throw notFound('Photo not found');
  const max = size === 'thumb' ? PHOTO_LIMITS.maxThumbBytes : PHOTO_LIMITS.maxBytes;
  return { body: await deps.storage.download(key, max), contentType: row.contentType };
}

/** FR-141: removes a photo (Owner/Admin); recorded, and its files deleted from storage. */
export async function removePhoto(
  ctx: RequestContext,
  photoId: string,
  deps: { storage: ObjectStorage },
): Promise<void> {
  authorize(ctx, 'property.manage');
  if (ctx.kind !== 'member') throw notFound('Photo not found');
  const id = parse(photoId, 'Photo');
  const removed = await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    // now() in SQL: the RESTRICTIVE update policy requires the transaction time exactly.
    const rows = await tx.$queryRaw<
      { property_id: string; storage_key: string; thumb_key: string }[]
    >`
      UPDATE property_photo SET removed_at = now(), removed_by = ${ctx.userId}::uuid
       WHERE id = ${id}::uuid AND removed_at IS NULL
      RETURNING property_id, storage_key, thumb_key`;
    const r = rows[0];
    if (!r) throw notFound('Photo not found');
    await writeAudit(tx, ctx.orgId, {
      action: 'property.photo_removed',
      entityType: 'property',
      entityId: r.property_id,
      actorUserId: ctx.userId,
      metadata: { photoId: id },
    });
    return r;
  });
  // After the commit: a failed delete leaves an unreferenced file, never a broken photo.
  const keys = [removed.storage_key, removed.thumb_key].filter((k) =>
    keyBelongsTo(k, ctx.orgId, 'property-photos', removed.property_id),
  );
  await deps.storage.remove(keys).catch((err: unknown) => {
    logger.warn({ err, photoId: id }, 'property photo: files of a removed photo were not deleted');
  });
}
