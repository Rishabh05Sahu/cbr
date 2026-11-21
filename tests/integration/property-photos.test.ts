// FR-141 property photos (migration 0030, ADR-0026): the role matrix (add/remove Owner/Admin; see
// Owner/Admin/SM/SE; HR none), the structural check (EXIF refused), private storage keys, loading
// through the module only, removal (recorded, files deleted), the 20-photo limit in the app and in
// the database, other orgs, and the database backstop as crm_app. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as properties from '@/modules/properties';
import { DomainError } from '@/platform/errors';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';
import { memoryStorage } from '../support/memory-storage';
import { testJpeg, testWebp } from '../support/test-images';

const APP = process.env.TEST_DATABASE_URL!;
/** As the schema owner over plain pg, so the Postgres error code is visible (Prisma wraps it). */
const asMigrator = (sql: string, params: unknown[]) =>
  withRole(process.env.TEST_MIGRATOR_URL!, (c) => c.query(sql, params));
type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';
let A: Org;
let B: Org;
const a = {} as Record<Role, Actor>;
let ownerB: Actor;
const storage = memoryStorage();
const deps = { storage };

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return 'OK';
}
async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERR';
  }
}
async function asApp(org: Org, userId: string, sql: string, params: unknown[] = []) {
  return withRole(APP, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [org.orgId, userId],
      );
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

let seq = 0;
async function property(by: Actor) {
  return (
    await properties.createProperty(by.ctx, {
      title: `Synthetic villa ${++seq}`,
      listingType: 'SALE',
      propertyType: 'VILLA',
      city: 'Dubai',
      locality: 'Dubai Hills',
      price: '4500000',
      priceType: 'TOTAL',
      bhk: '4',
    })
  ).id;
}
const jpegPair = () => ({ full: testJpeg(2048, 1536), thumb: testJpeg(480, 360) });
const webpPair = () => ({ full: testWebp(1600, 1200), thumb: testWebp(480, 360) });

beforeAll(async () => {
  A = await seedOrg('PhotoA');
  B = await seedOrg('PhotoB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('adding and seeing photos (role matrix §4.5)', () => {
  it('Owner and Admin add JPEG and WebP photos; files land under the property, privately', async () => {
    const pid = await property(a.owner);
    const first = await properties.addPhoto(a.owner.ctx, pid, jpegPair(), deps);
    const second = await properties.addPhoto(a.admin.ctx, pid, webpPair(), deps);
    const rows = await migrator().propertyPhoto.findMany({
      where: { propertyId: pid },
      orderBy: { uploadedAt: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(rows[0]).toMatchObject({ contentType: 'image/jpeg', width: 2048, height: 1536 });
    expect(rows[1]).toMatchObject({ contentType: 'image/webp', width: 1600, height: 1200 });
    for (const r of rows) {
      expect(r.storageKey).toMatch(new RegExp(`^orgs/${A.orgId}/property-photos/${pid}/`));
      expect(storage.objects.has(r.storageKey) && storage.objects.has(r.thumbKey)).toBe(true);
    }
    const audit = await migrator().auditLog.findMany({
      where: { orgId: A.orgId, action: 'property.photo_added', entityId: pid },
    });
    expect(audit).toHaveLength(2);
  });

  it('Sales Manager and Executive see and load photos but cannot add or remove; HR sees nothing', async () => {
    const pid = await property(a.owner);
    const { id } = await properties.addPhoto(a.owner.ctx, pid, jpegPair(), deps);
    for (const k of ['manager', 'exec1'] as const) {
      expect(
        (await properties.listPhotos(a[k].ctx, pid)).map((p) => p.id),
        k,
      ).toEqual([id]);
      const thumb = await properties.loadPhoto(a[k].ctx, pid, id, 'thumb', deps);
      expect(thumb.contentType).toBe('image/jpeg');
      expect(thumb.body).toEqual(testJpeg(480, 360));
      expect(await codeOf(properties.addPhoto(a[k].ctx, pid, jpegPair(), deps)), k).toBe(
        'FORBIDDEN',
      );
      expect(await codeOf(properties.removePhoto(a[k].ctx, id, deps)), k).toBe('FORBIDDEN');
    }
    expect(await codeOf(properties.listPhotos(a.hr.ctx, pid))).toBe('FORBIDDEN');
    expect(await codeOf(properties.loadPhoto(a.hr.ctx, pid, id, 'full', deps))).toBe('FORBIDDEN');
  });

  it('refuses an image that still has EXIF (location), a wrong type and a mismatched thumbnail', async () => {
    const pid = await property(a.owner);
    const exif = { full: testJpeg(800, 600, { exif: true }), thumb: testJpeg(400, 300) };
    expect(await codeOf(properties.addPhoto(a.owner.ctx, pid, exif, deps))).toBe(
      'VALIDATION_FAILED',
    );
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(
      await codeOf(properties.addPhoto(a.owner.ctx, pid, { full: svg, thumb: svg }, deps)),
    ).toBe('VALIDATION_FAILED');
    const mixed = { full: testJpeg(800, 600), thumb: testWebp(400, 300) };
    expect(await codeOf(properties.addPhoto(a.owner.ctx, pid, mixed, deps))).toBe(
      'VALIDATION_FAILED',
    );
    const bigThumb = { full: testJpeg(800, 600), thumb: testJpeg(1200, 900) };
    expect(await codeOf(properties.addPhoto(a.owner.ctx, pid, bigThumb, deps))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await migrator().propertyPhoto.count({ where: { propertyId: pid } })).toBe(0);
  });
});

describe('removing, limits and isolation', () => {
  it('removal is recorded, hides the photo and deletes its files', async () => {
    const pid = await property(a.owner);
    const { id } = await properties.addPhoto(a.owner.ctx, pid, jpegPair(), deps);
    const row = await migrator().propertyPhoto.findUniqueOrThrow({ where: { id } });
    await properties.removePhoto(a.admin.ctx, id, deps);
    expect(await properties.listPhotos(a.owner.ctx, pid)).toEqual([]);
    expect(await codeOf(properties.loadPhoto(a.owner.ctx, pid, id, 'full', deps))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(properties.removePhoto(a.owner.ctx, id, deps))).toBe('NOT_FOUND');
    const after = await migrator().propertyPhoto.findUniqueOrThrow({ where: { id } });
    expect(after.removedAt).not.toBeNull();
    expect(after.removedBy).toBe(A.users.admin.id);
    expect(storage.objects.has(row.storageKey) || storage.objects.has(row.thumbKey)).toBe(false);
  });

  it('allows 20 photos per property: the 21st is refused (app), and the database refuses it too', async () => {
    const pid = await property(a.owner);
    for (let i = 0; i < 20; i++) await properties.addPhoto(a.owner.ctx, pid, webpPair(), deps);
    expect(await codeOf(properties.addPhoto(a.owner.ctx, pid, webpPair(), deps))).toBe(
      'RULE_VIOLATION',
    );
    const key = (n: number) =>
      `orgs/${A.orgId}/property-photos/${pid}/${String(n).padStart(32, 'a')}.webp`;
    expect(
      await sqlState(
        asMigrator(
          `INSERT INTO property_photo (org_id, property_id, storage_key, thumb_key, content_type, width, height, bytes, thumb_bytes, uploaded_by) VALUES ($1, $2, $3, $4, $5, 10, 10, 10, 10, $6)`,
          [A.orgId, pid, key(1), key(2), 'image/webp', A.users.owner.id],
        ),
      ),
    ).toBe('23514');
    // Removing one makes room again.
    const [oldest] = await properties.listPhotos(a.owner.ctx, pid);
    await properties.removePhoto(a.owner.ctx, oldest!.id, deps);
    expect(await codeOf(properties.addPhoto(a.owner.ctx, pid, webpPair(), deps))).toBe('OK');
  });

  it('another org sees, loads and removes nothing; keys must name the photo own org and property', async () => {
    const pid = await property(a.owner);
    const { id } = await properties.addPhoto(a.owner.ctx, pid, jpegPair(), deps);
    expect(await codeOf(properties.listPhotos(ownerB.ctx, pid))).toBe('OK');
    expect(await properties.listPhotos(ownerB.ctx, pid)).toEqual([]);
    expect(await codeOf(properties.loadPhoto(ownerB.ctx, pid, id, 'full', deps))).toBe('NOT_FOUND');
    expect(await codeOf(properties.removePhoto(ownerB.ctx, id, deps))).toBe('NOT_FOUND');
    expect(await codeOf(properties.addPhoto(ownerB.ctx, pid, jpegPair(), deps))).toBe('NOT_FOUND');
    const foreignKey = `orgs/${B.orgId}/property-photos/${pid}/${'b'.repeat(32)}.jpg`;
    expect(
      await sqlState(
        asMigrator(
          `INSERT INTO property_photo (org_id, property_id, storage_key, thumb_key, content_type, width, height, bytes, thumb_bytes, uploaded_by) VALUES ($1, $2, $3, $4, $5, 10, 10, 10, 10, $6)`,
          [A.orgId, pid, foreignKey, foreignKey + 'x', 'image/jpeg', A.users.owner.id],
        ),
      ),
    ).toBe('23514');
  });

  it('database backstop (crm_app): Sales roles cannot insert or remove, nobody deletes', async () => {
    const pid = await property(a.owner);
    const { id } = await properties.addPhoto(a.owner.ctx, pid, jpegPair(), deps);
    const key = `orgs/${A.orgId}/property-photos/${pid}/${'c'.repeat(32)}.jpg`;
    expect(
      await sqlState(
        asApp(
          A,
          A.users.exec1.id,
          `INSERT INTO property_photo (org_id, property_id, storage_key, thumb_key, content_type,
             width, height, bytes, thumb_bytes, uploaded_by, uploaded_at)
           VALUES ($1, $2, $3, $4, 'image/jpeg', 10, 10, 10, 10, $5, now())`,
          [A.orgId, pid, key, key.replace('ccc', 'ddd'), A.users.exec1.id],
        ),
      ),
    ).toBe('42501');
    const removed = await asApp(
      A,
      A.users.manager.id,
      `UPDATE property_photo SET removed_at = now(), removed_by = $2 WHERE id = $1`,
      [id, A.users.manager.id],
    );
    expect(removed.rowCount).toBe(0);
    expect(
      await sqlState(asApp(A, A.users.owner.id, `DELETE FROM property_photo WHERE id = $1`, [id])),
    ).toBe('42501');
  });
});
