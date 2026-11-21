// FR-141 property photos over HTTP against the built server and its (fake) private storage: the
// upload route (multipart, same-origin only, Owner/Admin), the serving route (each role, other
// orgs, removed photos), and that every response is private. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as properties from '@/modules/properties';
import { actorIn, PASSWORD, seedOrg } from '../support/factory';
import { testJpeg, testWebp } from '../support/test-images';
import { Browser } from './http';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let pid: string;

async function browserFor(user: { email: string }, orgId: string): Promise<Browser> {
  const b = new Browser();
  expect((await b.signIn(user.email, PASSWORD)).status).toBe(200);
  expect((await b.authPost('/organization/set-active', { organizationId: orgId })).status).toBe(
    200,
  );
  return b;
}
function form(full: Uint8Array<ArrayBuffer>, thumb: Uint8Array<ArrayBuffer>, type: string) {
  const f = new FormData();
  f.append('photo', new Blob([full], { type }), 'photo');
  f.append('thumb', new Blob([thumb], { type }), 'thumb');
  return f;
}
const upload = (
  b: Browser,
  propertyId: string,
  body: FormData,
  headers: Record<string, string> = {},
) => b.fetch(`/app/properties/${propertyId}/photos`, { method: 'POST', body, headers });

beforeAll(async () => {
  A = await seedOrg('PhotoRouteA');
  B = await seedOrg('PhotoRouteB');
  const owner = await actorIn(A.users.owner, A.orgId);
  pid = (
    await properties.createProperty(owner.ctx, {
      title: 'Synthetic townhouse',
      listingType: 'SALE',
      propertyType: 'VILLA',
      city: 'Dubai',
      price: '3200000',
      priceType: 'TOTAL',
    })
  ).id;
});

describe('upload route', () => {
  it('the Owner uploads a photo; the Executive sees it, full size and thumbnail', async () => {
    const owner = await browserFor(A.users.owner, A.orgId);
    const res = await upload(
      owner,
      pid,
      form(testJpeg(2048, 1536), testJpeg(480, 360), 'image/jpeg'),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const { id } = (await res.json()) as { id: string };

    const exec = await browserFor(A.users.exec1, A.orgId);
    const thumb = await exec.get(`/app/properties/${pid}/photos/${id}?size=thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    expect(thumb.headers.get('cache-control')).toBe('private, no-store');
    expect(thumb.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(testJpeg(480, 360));
    const full = await exec.get(`/app/properties/${pid}/photos/${id}`);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(testJpeg(2048, 1536));

    // The property page shows it, through the app route only (no storage URL).
    const html = await (await exec.get(`/app/properties/${pid}`)).text();
    expect(html).toContain(`/app/properties/${pid}/photos/${id}?size=thumb`);
    expect(html).not.toContain('property-photos/');
  });

  it('refuses cross-site posts, Sales roles, other orgs, EXIF and oversized bodies', async () => {
    const owner = await browserFor(A.users.owner, A.orgId);
    const good = () => form(testWebp(1600, 1200), testWebp(480, 360), 'image/webp');
    expect((await upload(owner, pid, good(), { origin: 'https://evil.example' })).status).toBe(403);
    for (const k of ['manager', 'exec1'] as const) {
      const b = await browserFor(A.users[k], A.orgId);
      expect((await upload(b, pid, good())).status, k).toBe(404);
    }
    const ownerB = await browserFor(B.users.owner, B.orgId);
    expect((await upload(ownerB, pid, good())).status).toBe(404);
    const exif = form(testJpeg(800, 600, { exif: true }), testJpeg(400, 300), 'image/jpeg');
    const refused = await upload(owner, pid, exif);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toMatch(/metadata/);
    const huge = new FormData();
    huge.append('photo', new Blob([new ArrayBuffer(12 * 1024 * 1024)]), 'photo');
    huge.append('thumb', new Blob([testWebp(10, 10)]), 'thumb');
    expect((await upload(owner, pid, huge)).status).toBe(413);
    const anon = new Browser();
    expect((await upload(anon, pid, good())).status).toBe(401);
  });
});

describe('serving route', () => {
  it('HR, other orgs, removed photos and unknown ids get 404; no session gets 401', async () => {
    const owner = await browserFor(A.users.owner, A.orgId);
    const res = await upload(
      owner,
      pid,
      form(testWebp(1600, 1200), testWebp(480, 360), 'image/webp'),
    );
    const { id } = (await res.json()) as { id: string };
    const path = `/app/properties/${pid}/photos/${id}`;
    expect((await (await browserFor(A.users.hr, A.orgId)).get(path)).status).toBe(404);
    expect((await (await browserFor(B.users.owner, B.orgId)).get(path)).status).toBe(404);
    expect((await owner.get(`/app/properties/${pid}/photos/${crypto.randomUUID()}`)).status).toBe(
      404,
    );
    const ownerActor = await actorIn(A.users.owner, A.orgId);
    await properties.removePhoto(ownerActor.ctx, id, {
      storage: { remove: async () => {} } as never,
    });
    expect((await owner.get(path)).status).toBe(404);
    const anon = new Browser();
    const r = await anon.get(path);
    expect([401, 302, 303, 307]).toContain(r.status);
  });
});
