// App 1.0.4 endpoints (ADR-0027 slice 6) against the built server: new lead with the duplicate
// check, tasks, unlogged calls, calendar, properties with photo upload, scripts, dashboard and
// people. Role scope and cross-org isolation on each. Synthetic data only.
import { randomInt } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import { actorIn, seedOrg } from '../support/factory';
import { testJpeg } from '../support/test-images';
import { appFor, json } from './app-client';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let exec1Lead: string;
let exec2Lead: string;

const created = async (r: Promise<leads.CreateLeadResult>) => {
  const v = await r;
  if (v.status !== 'created') throw new Error('expected a new lead');
  return v.leadId;
};

beforeAll(async () => {
  A = await seedOrg('EverydayA');
  B = await seedOrg('EverydayB');
  const e1 = await actorIn(A.users.exec1, A.orgId);
  const e2 = await actorIn(A.users.exec2, A.orgId);
  exec1Lead = await created(
    leads.createLead(e1.ctx, { fullName: 'Everyday One', primaryPhone: '9833300001' }),
  );
  exec2Lead = await created(
    leads.createLead(e2.ctx, { fullName: 'Everyday Two', primaryPhone: '9833300002' }),
  );
});

describe('everyday work', () => {
  it('an executive adds a lead; the same number again is a duplicate pointing at it', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    const phone = `98222${randomInt(10000, 99999)}`;
    const made = await json(
      await app.api('/leads', {
        method: 'POST',
        body: { fullName: 'Walk In', primaryPhone: phone },
      }),
    );
    expect(made.data).toMatchObject({ status: 'created' });
    const again = await json(
      await app.api('/leads', {
        method: 'POST',
        body: { fullName: 'Walk In 2', primaryPhone: phone },
      }),
    );
    expect(again.data).toMatchObject({ status: 'duplicate', leadId: made.data.leadId });
    const bad = await app.api('/leads', {
      method: 'POST',
      body: { fullName: '', primaryPhone: 'x' },
    });
    expect(bad.status).toBe(422);
    expect((await app.api('/lead-sources')).status).toBe(200);
    const hr = await appFor(A.users.hr, A.orgId);
    expect(
      (await hr.api('/leads', { method: 'POST', body: { fullName: 'x', primaryPhone: phone } }))
        .status,
    ).toBe(403);
  });

  it('adds a call task on a lead; it shows in the calendar; HR cannot add lead tasks', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    const lead = await json(await app.api(`/leads/${exec1Lead}`));
    const due = `${(lead.data.nowLocal as string).slice(0, 10)}T23:00`;
    const task = await app.api('/tasks', {
      method: 'POST',
      body: { leadId: exec1Lead, type: 'CALL', title: 'Send brochure', dueAt: due },
    });
    expect(task.status, JSON.stringify(await task.clone().json())).toBe(200);
    // An executive gives tasks only to themselves: no one else is offered.
    const people = await json(await app.api(`/task-assignees?leadId=${exec1Lead}`));
    expect(people.data.people).toEqual([]);
    const cal = await json(await app.api('/calendar?view=week'));
    expect(cal.ok, JSON.stringify(cal)).toBe(true);
    const titles = Object.values(cal.data.byDay as Record<string, { title: string }[]>)
      .flat()
      .map((i) => i.title);
    expect(titles).toContain('Send brochure');
    const hr = await appFor(A.users.hr, A.orgId);
    const refused = await hr.api('/tasks', {
      method: 'POST',
      body: { leadId: exec1Lead, type: 'CALL', title: 'x', dueAt: due },
    });
    expect([403, 404]).toContain(refused.status);
  });

  it('a tapped call with no outcome is listed until the outcome is logged', async () => {
    const app = await appFor(A.users.exec2, A.orgId);
    const tap = await json(
      await app.api(`/leads/${exec2Lead}/call-intents`, {
        method: 'POST',
        body: { channel: 'PHONE_NATIVE' },
      }),
    );
    expect(tap.ok, JSON.stringify(tap)).toBe(true);
    const listed = await json(await app.api('/unlogged-calls'));
    expect(listed.data.rows).toEqual([
      expect.objectContaining({
        leadId: exec2Lead,
        leadName: 'Everyday Two',
        channel: 'PHONE_NATIVE',
      }),
    ]);
    // Someone else never sees exec2's taps.
    const other = await appFor(A.users.exec1, A.orgId);
    const theirs = (await json(await other.api('/unlogged-calls'))).data.rows;
    expect(theirs.map((r: { leadId: string }) => r.leadId)).not.toContain(exec2Lead);

    const lead = await json(await app.api(`/leads/${exec2Lead}`));
    const logged = await json(
      await app.api('/interactions', {
        method: 'POST',
        body: {
          leadId: exec2Lead,
          idempotencyKey: crypto.randomUUID(),
          version: lead.data.lead.version,
          channel: 'PHONE_NATIVE',
          direction: 'OUTBOUND',
          outcome: 'NO_ANSWER',
          occurredAt: listed.data.rows[0].occurredAt,
        },
      }),
    );
    expect(logged.ok, JSON.stringify(logged)).toBe(true);
    expect((await json(await app.api('/unlogged-calls'))).data.rows).toEqual([]);
  });
});

describe('properties, scripts, dashboard, people', () => {
  it('the owner adds a property and a photo; an executive reads it but cannot add', async () => {
    const owner = await appFor(A.users.owner, A.orgId);
    const made = await json(
      await owner.api('/properties', {
        method: 'POST',
        body: {
          title: 'App villa',
          listingType: 'SALE',
          propertyType: 'VILLA',
          city: 'Dubai',
          price: '2500000',
          priceType: 'TOTAL',
        },
      }),
    );
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const id = made.data.id as string;
    const f = new FormData();
    f.append('photo', new Blob([testJpeg(1600, 1200)], { type: 'image/jpeg' }), 'photo');
    f.append('thumb', new Blob([testJpeg(480, 360)], { type: 'image/jpeg' }), 'thumb');
    const up = await owner.upload(`/properties/${id}/photos`, f);
    expect(up.status, await up.clone().text()).toBe(200);
    const photoId = (await json(up)).data.id as string;

    const exec = await appFor(A.users.exec1, A.orgId);
    const detail = await json(await exec.api(`/properties/${id}`));
    expect(detail.data.canManage).toBe(false);
    expect(detail.data.photos.map((p: { id: string }) => p.id)).toEqual([photoId]);
    const thumb = await exec.api(`/properties/${id}/photos/${photoId}?size=thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    expect(thumb.headers.get('cache-control')).toContain('no-store');
    expect((await json(await exec.api('/properties'))).data.rows.length).toBeGreaterThan(0);
    expect((await exec.api('/properties', { method: 'POST', body: { title: 'x' } })).status).toBe(
      403,
    );
    const f2 = new FormData();
    f2.append('photo', new Blob([testJpeg(800, 600)], { type: 'image/jpeg' }), 'photo');
    f2.append('thumb', new Blob([testJpeg(400, 300)], { type: 'image/jpeg' }), 'thumb');
    expect((await exec.upload(`/properties/${id}/photos`, f2)).status).toBe(403);

    // Another organisation cannot see it or its photos.
    const ownerB = await appFor(B.users.owner, B.orgId);
    expect((await ownerB.api(`/properties/${id}`)).status).toBe(404);
    expect((await ownerB.api(`/properties/${id}/photos/${photoId}?size=thumb`)).status).toBe(404);
  });

  it("scripts and the dashboard answer in the caller's scope", async () => {
    const exec = await appFor(A.users.exec1, A.orgId);
    expect((await json(await exec.api('/scripts'))).ok).toBe(true);
    const mine = await json(await exec.api('/dashboard?period=30d'));
    expect(mine.ok, JSON.stringify(mine)).toBe(true);
    expect(mine.data.kpis.length).toBeGreaterThan(0);
    expect(mine.data.kpis[0]).not.toHaveProperty('def');
    const owner = await appFor(A.users.owner, A.orgId);
    expect((await json(await owner.api('/dashboard'))).ok).toBe(true);
  });

  it('people: the admin suspends and reactivates an executive; others cannot', async () => {
    const admin = await appFor(A.users.admin, A.orgId);
    const list = await json(await admin.api('/members'));
    expect(list.data.can).toMatchObject({ invite: true, suspend: true });
    expect(list.data.grantableRoles).not.toContain('owner');
    type M = { userId: string; membershipId: string };
    const idOf = (u: { id: string }) =>
      (list.data.members as M[]).find((m) => m.userId === u.id)!.membershipId;
    const exec2m = idOf(A.users.exec2);
    expect((await admin.api(`/members/${exec2m}/suspend`, { method: 'POST' })).status).toBe(200);
    expect((await admin.api(`/members/${exec2m}/reactivate`, { method: 'POST' })).status).toBe(200);
    // An admin cannot suspend the owner.
    expect(
      (await admin.api(`/members/${idOf(A.users.owner)}/suspend`, { method: 'POST' })).status,
    ).not.toBe(200);
    const exec = await appFor(A.users.exec1, A.orgId);
    expect((await exec.api(`/members/${exec2m}/suspend`, { method: 'POST' })).status).toBe(403);
    const ownerB = await appFor(B.users.owner, B.orgId);
    expect((await ownerB.api(`/members/${exec2m}/suspend`, { method: 'POST' })).status).toBe(404);
  });
});
