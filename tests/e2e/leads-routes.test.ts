// Phase 2 M1–M3: lead pages and Server Actions over HTTP against the built server —
// unauthenticated access, role/scope 404s, another org's ids, and forged form fields.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import { migrator } from '../support/db';
import { actorIn, PASSWORD, seedOrg } from '../support/factory';
import { E2E_STORAGE_KEY } from './fake-storage';
import { Browser } from './http';

const L = 'src/modules/leads/actions.ts';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let aLead: string;
let bLead: string;

async function browserFor(user: { email: string }, orgId: string): Promise<Browser> {
  const b = new Browser();
  expect((await b.signIn(user.email, PASSWORD)).status).toBe(200);
  expect((await b.authPost('/organization/set-active', { organizationId: orgId })).status).toBe(
    200,
  );
  return b;
}

const created = async (r: Promise<leads.CreateLeadResult>) => {
  const v = await r;
  if (v.status !== 'created') throw new Error('expected a new lead');
  return v.leadId;
};

beforeAll(async () => {
  A = await seedOrg('LeadRouteA');
  B = await seedOrg('LeadRouteB');
  const exec1 = await actorIn(A.users.exec1, A.orgId);
  const ownerB = await actorIn(B.users.owner, B.orgId);
  aLead = await created(
    leads.createLead(exec1.ctx, { fullName: 'Alpha Customer', primaryPhone: '9811111111' }),
  );
  bLead = await created(
    leads.createLead(ownerB.ctx, { fullName: 'Bravo Customer', primaryPhone: '9822222222' }),
  );
});

describe('unauthenticated', () => {
  it('lead pages redirect to sign-in and actions are refused', async () => {
    const anon = new Browser();
    for (const path of ['/app/leads', '/app/leads/new', `/app/leads/${aLead}`]) {
      const res = await anon.get(path);
      expect([302, 303, 307], path).toContain(res.status);
      expect(res.headers.get('location'), path).toMatch(/\/login/);
    }
    expect(
      await anon.action('/app/leads/new', L, 'createLeadAction', {
        fullName: 'Anon',
        primaryPhone: '9833333333',
      }),
    ).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    expect(
      await anon.action(`/app/leads/${aLead}`, L, 'addNoteAction', { leadId: aLead, body: 'x' }),
    ).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
  });
});

describe('roles, scope and organisations on the real routes', () => {
  it('the owner of org A cannot open or change an org B lead', async () => {
    const b = await browserFor(A.users.owner, A.orgId);
    expect((await b.get(`/app/leads/${bLead}`)).status).toBe(404);
    const list = (await (await b.get('/app/leads')).text()).replace(/<!-- -->/g, '');
    expect(list).toContain('Alpha Customer');
    expect(list).not.toContain('Bravo Customer');
    expect(
      await b.action(`/app/leads/${bLead}`, L, 'changeStageAction', {
        leadId: bLead,
        toStage: 'CONTACTED',
        version: '1',
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(
      await b.action(`/app/leads/${bLead}`, L, 'addNoteAction', { leadId: bLead, body: 'x' }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await migrator().leadNote.count({ where: { leadId: bLead } })).toBe(0);
  });

  it('list search, filters and cursors stay inside the org and fail safely', async () => {
    const b = await browserFor(A.users.owner, A.orgId);
    const html = async (path: string) => {
      const res = await b.get(path);
      expect(res.status, path).toBe(200);
      return (await res.text()).replace(/<!-- -->/g, '');
    };
    const bravo = Buffer.from(JSON.stringify({ s: 'newest', id: bLead })).toString('base64url');
    for (const path of [
      '/app/leads?q=Bravo',
      '/app/leads?q=9822222222',
      `/app/leads?owner=${B.users.owner.id}`,
      `/app/leads?cursor=${bravo}`,
      `/app/leads?orgId=${B.orgId}`,
    ])
      expect(await html(path), path).not.toContain('Bravo Customer');
    expect(await html('/app/leads?q=Alpha&stage=ASSIGNED')).toContain('Alpha Customer');
    expect(await html('/app/leads?stage=BOGUS')).toContain('Unknown stage');
    expect(await html('/app/leads?cursor=garbage')).toContain('no longer valid');
    expect(await html('/app/leads?q=zz-nothing')).toContain('No leads match these filters.');
  });

  it("another executive's lead is 404; HR has no lead pages", async () => {
    const exec2 = await browserFor(A.users.exec2, A.orgId);
    expect((await exec2.get(`/app/leads/${aLead}`)).status).toBe(404);
    const hr = await browserFor(A.users.hr, A.orgId);
    expect((await hr.get('/app/leads')).status).toBe(404);
    expect((await hr.get('/app/leads/new')).status).toBe(404);
    expect(
      await hr.action('/app/leads/new', L, 'createLeadAction', {
        fullName: 'HR',
        primaryPhone: '9844444444',
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('forged org, owner and actor fields are ignored by createLeadAction', async () => {
    const b = await browserFor(A.users.exec1, A.orgId);
    const r = await b.action('/app/leads/new', L, 'createLeadAction', {
      fullName: 'Forged Fields',
      primaryPhone: '98555 55555',
      orgId: B.orgId,
      ownerUserId: A.users.owner.id,
      createdBy: A.users.owner.id,
      stage: 'WON',
    });
    expect(r.ok).not.toBe(false); // success redirects to the new lead (no ActionResult)
    const lead = await migrator().lead.findFirstOrThrow({
      where: { primaryPhoneE164: '+919855555555' },
    });
    expect(lead).toMatchObject({
      orgId: A.orgId,
      ownerUserId: A.users.exec1.id,
      createdBy: A.users.exec1.id,
      stage: 'ASSIGNED',
    });
    expect((await b.get(`/app/leads/${lead.id}`)).status).toBe(200);
  });
});

describe('M3: queue, assignment and notifications on the real routes', () => {
  const N = 'src/modules/notifications/actions.ts';

  it('the queue is for assigners only; anonymous users are sent to sign-in', async () => {
    for (const k of ['exec1', 'hr'] as const) {
      const b = await browserFor(A.users[k], A.orgId);
      expect((await b.get('/app/leads/queue')).status, k).toBe(404);
    }
    expect(
      (await (await browserFor(A.users.manager, A.orgId)).get('/app/leads/queue')).status,
    ).toBe(200);
    const anon = await new Browser().get('/app/leads/queue');
    expect(anon.headers.get('location')).toMatch(/\/login/);
    expect((await new Browser().get('/app/notifications')).headers.get('location')).toMatch(
      /\/login/,
    );
  });

  it('assignment actions enforce role, org and target over HTTP', async () => {
    const exec = await browserFor(A.users.exec1, A.orgId);
    expect(
      await exec.action(`/app/leads/${aLead}`, L, 'assignLeadAction', {
        leadId: aLead,
        target: `user:${A.users.exec2.id}`,
        version: '1',
        reason: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    const owner = await browserFor(A.users.owner, A.orgId);
    expect(
      await owner.action(`/app/leads/${bLead}`, L, 'assignLeadAction', {
        leadId: bLead,
        target: `user:${A.users.exec1.id}`,
        version: '1',
        reason: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(
      await owner.action(`/app/leads/${aLead}`, L, 'assignLeadAction', {
        leadId: aLead,
        target: `user:${B.users.exec1.id}`,
        version: '1',
        reason: 'x',
      }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(
      await owner.action('/app/leads/queue', L, 'bulkAssignAction', {
        leadId: bLead,
        target: `user:${A.users.exec1.id}`,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const b = await migrator().lead.findUniqueOrThrow({ where: { id: bLead } });
    expect(b.ownerUserId).toBe(B.users.owner.id);
    // A real reassignment works end to end.
    expect(
      await owner.action(`/app/leads/${aLead}`, L, 'assignLeadAction', {
        leadId: aLead,
        target: `user:${A.users.exec2.id}`,
        version: String(
          (await migrator().lead.findUniqueOrThrow({ where: { id: aLead } })).version,
        ),
        reason: 'Cover',
      }),
    ).toMatchObject({ ok: true });
    expect((await migrator().lead.findUniqueOrThrow({ where: { id: aLead } })).ownerUserId).toBe(
      A.users.exec2.id,
    );
  });

  it("another member's notification cannot be read or marked", async () => {
    const n = await migrator().notification.create({
      data: {
        orgId: A.orgId,
        recipientUserId: A.users.exec2.id,
        type: 'LEAD_ASSIGNED',
        title: 'Private notice for exec2',
        body: 'x',
      },
    });
    const exec1 = await browserFor(A.users.exec1, A.orgId);
    const page = (await (await exec1.get('/app/notifications')).text()).replace(/<!-- -->/g, '');
    expect(page).not.toContain('Private notice for exec2');
    expect(
      await exec1.action('/app/notifications', N, 'markReadAction', { notificationId: n.id }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const exec2 = await browserFor(A.users.exec2, A.orgId);
    const mine = (await (await exec2.get('/app/notifications')).text()).replace(/<!-- -->/g, '');
    expect(mine).toContain('Private notice for exec2');
    expect(
      await exec2.action('/app/notifications', N, 'markReadAction', { notificationId: n.id }),
    ).toMatchObject({ ok: true });
  });
});

describe('M4: import page', () => {
  it('Owners and Admins get the upload form and no storage secret; others get 404', async () => {
    for (const k of ['owner', 'admin'] as const) {
      const b = await browserFor(A.users[k], A.orgId);
      const res = await b.get('/app/leads/import');
      expect(res.status, k).toBe(200);
      const html = (await res.text()).replace(/<!-- -->/g, '');
      expect(html).toContain('Upload and check');
      expect(html).toMatch(/type="file"/);
      expect(html).not.toMatch(/sb_secret|service_role|SUPABASE_/i);
      expect(html).not.toContain(E2E_STORAGE_KEY);
    }
    for (const k of ['manager', 'exec1', 'hr'] as const) {
      const b = await browserFor(A.users[k], A.orgId);
      expect((await b.get('/app/leads/import')).status, k).toBe(404);
    }
    const anon = await new Browser().get('/app/leads/import');
    expect(anon.headers.get('location')).toMatch(/\/login/);
  });
});
