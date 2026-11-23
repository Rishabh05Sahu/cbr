// ADR-0027 Android app API against the built server: the bearer sign-in exactly as the app does it
// (Origin cbrcrm://app, the 2FA step with its short-lived cookie, then the token only), the token
// header withheld from the website, cookies refused on /api/v1, and role scope and cross-org
// isolation on every app endpoint.
import { randomInt } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as tasks from '@/modules/tasks';
import * as teams from '@/modules/teams';
import * as visits from '@/modules/visits';
import { migrator } from '../support/db';
import { actorIn, PASSWORD, seedOrg } from '../support/factory';
import { authenticators, totp } from '../support/totp';
import { Browser, BASE } from './http';

const APP_ORIGIN = 'cbrcrm://app';

/** The app's HTTP client: no cookie jar beyond the 2FA step, a bearer token afterwards. */
class App {
  token: string | null = null;
  private twoFactorCookie: string | null = null;
  /** One phone, one address: sign-in rate limits are per IP. */
  readonly ip = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;

  async auth(path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      origin: APP_ORIGIN,
      'x-forwarded-for': this.ip,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.twoFactorCookie) headers.cookie = this.twoFactorCookie;
    const res = await fetch(`${BASE}/api/auth${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]!;
      if (pair.includes('two_factor=')) this.twoFactorCookie = pair;
    }
    const t = res.headers.get('set-auth-token');
    if (t) {
      this.token = t;
      this.twoFactorCookie = null;
    }
    return res;
  }

  async signIn(email: string): Promise<Response> {
    const res = await this.auth('/sign-in/email', { email, password: PASSWORD });
    const body = (await res.clone().json()) as { twoFactorRedirect?: boolean };
    if (!body.twoFactorRedirect) return res;
    return this.auth('/two-factor/verify-totp', {
      code: totp(authenticators.get(email.toLowerCase())!),
    });
  }

  api(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    return fetch(`${BASE}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'x-forwarded-for': this.ip,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }
}

async function appFor(user: { email: string }, orgId: string): Promise<App> {
  const app = new App();
  expect((await app.signIn(user.email)).status).toBe(200);
  expect(app.token).toBeTruthy();
  expect((await app.auth('/organization/set-active', { organizationId: orgId })).status).toBe(200);
  return app;
}

const json = async (res: Response) =>
  (await res.json()) as { ok: boolean; data?: any; error?: { code: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let exec1Lead: string;
let exec2Lead: string;
let bLead: string;

const created = async (r: Promise<leads.CreateLeadResult>) => {
  const v = await r;
  if (v.status !== 'created') throw new Error('expected a new lead');
  return v.leadId;
};

beforeAll(async () => {
  A = await seedOrg('AppA');
  B = await seedOrg('AppB');
  const e1 = await actorIn(A.users.exec1, A.orgId);
  const e2 = await actorIn(A.users.exec2, A.orgId);
  const ownerB = await actorIn(B.users.owner, B.orgId);
  exec1Lead = await created(
    leads.createLead(e1.ctx, { fullName: 'Alpha Mobile', primaryPhone: '9811100001' }),
  );
  exec2Lead = await created(
    leads.createLead(e2.ctx, { fullName: 'Second Mobile', primaryPhone: '9811100002' }),
  );
  bLead = await created(
    leads.createLead(ownerB.ctx, { fullName: 'Bravo Mobile', primaryPhone: '9811100003' }),
  );
});

describe('sign-in', () => {
  it('the app receives a token; the website never sees it', async () => {
    const app = new App();
    expect((await app.signIn(A.users.exec1.email)).status).toBe(200);
    expect(app.token).toMatch(/\./); // signed

    const web = new Browser();
    const res = await web.signIn(A.users.exec1.email, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-auth-token')).toBeNull();
    expect(res.headers.get('access-control-expose-headers') ?? '').not.toMatch(/set-auth-token/i);
  });

  it('owners complete the authenticator step and get a token', async () => {
    const app = await appFor(A.users.owner, A.orgId);
    const me = await json(await app.api('/me'));
    expect(me.data.active).toMatchObject({ orgId: A.orgId, role: 'OWNER' });
  });

  it('me works before an organisation is chosen and lists memberships', async () => {
    const app = new App();
    await app.signIn(A.users.exec1.email);
    const me = await json(await app.api('/me'));
    expect(me.ok).toBe(true);
    expect(me.data.memberships.map((m: { orgId: string }) => m.orgId)).toEqual([A.orgId]);
    expect(me.data.active).toBeNull();
    expect(me.data.blocked).toBe('NO_ACTIVE_ORG');
    expect((await app.api('/my-day')).status).toBe(403);
  });

  it('sign-out ends the token', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    expect((await app.api('/me')).status).toBe(200);
    expect((await app.auth('/sign-out', {})).status).toBe(200);
    expect((await app.api('/me')).status).toBe(401);
  });
});

describe('/api/v1 accepts the bearer token only', () => {
  it('no token, a forged token, an unsigned token and a website cookie are all 401', async () => {
    const anon = new App();
    expect((await anon.api('/me')).status).toBe(401);
    for (const bad of ['garbage', 'abc.def', 'raw-session-token-without-signature']) {
      anon.token = bad;
      const res = await anon.api('/me');
      expect(res.status, bad).toBe(401);
      expect((await json(res)).error?.code).toBe('UNAUTHENTICATED');
    }
    const web = new Browser();
    await web.signIn(A.users.exec1.email, PASSWORD);
    await web.authPost('/organization/set-active', { organizationId: A.orgId });
    const res = await fetch(`${BASE}/api/v1/my-day`, { headers: { cookie: web.cookieHeader() } });
    expect(res.status).toBe(401);
  });

  it('responses are private and never cached', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    const res = await app.api('/my-day');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('scope and isolation', () => {
  it('an executive sees only their own leads', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    const list = await json(await app.api('/leads'));
    const ids = list.data.rows.map((r: { id: string }) => r.id);
    expect(ids).toContain(exec1Lead);
    expect(ids).not.toContain(exec2Lead);
    expect(ids).not.toContain(bLead);
    expect((await app.api(`/leads/${exec1Lead}`)).status).toBe(200);
    expect((await app.api(`/leads/${exec2Lead}`)).status).toBe(404);
    expect((await app.api(`/leads/${bLead}`)).status).toBe(404);
    expect((await app.api(`/leads/${bLead}/reveal-phone`, { method: 'POST' })).status).toBe(404);
  });

  it('an owner sees the whole organisation, never another one', async () => {
    const app = await appFor(A.users.owner, A.orgId);
    const ids = (await json(await app.api('/leads'))).data.rows.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([exec1Lead, exec2Lead]));
    expect(ids).not.toContain(bLead);
    expect((await app.api(`/leads/${bLead}`)).status).toBe(404);
  });

  it('HR / Ops has My Day but no lead data', async () => {
    const app = await appFor(A.users.hr, A.orgId);
    expect((await app.api('/my-day')).status).toBe(200);
    expect((await app.api('/leads')).status).toBe(403);
    expect((await app.api(`/leads/${exec1Lead}`)).status).toBe(403);
    const me = await json(await app.api('/me'));
    expect(me.data.active.permissions['lead.read']).toBeUndefined();
  });

  it('cannot switch into an organisation the user does not belong to', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    const res = await app.auth('/organization/set-active', { organizationId: B.orgId });
    expect(res.status).toBe(403);
    // Better Auth clears the active organisation on a refused switch: the app shows the picker.
    const me = await json(await app.api('/me'));
    expect(me.data.active?.orgId ?? null).not.toBe(B.orgId);
    expect((await app.api(`/leads/${bLead}`)).status).not.toBe(200);
  });

  it('a 2FA sign-in hands out no token before the second factor', async () => {
    const res = await fetch(`${BASE}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: APP_ORIGIN,
        'x-forwarded-for': `10.1.${randomInt(0, 255)}.${randomInt(1, 254)}`,
      },
      body: JSON.stringify({ email: A.users.admin.email, password: PASSWORD }),
    });
    expect(((await res.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect(res.headers.get('set-auth-token')).toBeNull();
  });
});

describe('the call loop', () => {
  it('tap Call, then log the outcome; the pending tap clears', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    const tap = await json(
      await app.api(`/leads/${exec1Lead}/call-intents`, {
        method: 'POST',
        body: { channel: 'PHONE_NATIVE' },
      }),
    );
    expect(tap.ok, JSON.stringify(tap)).toBe(true);
    expect(tap.data.href).toMatch(/^tel:\+91/);

    const lead = await json(await app.api(`/leads/${exec1Lead}`));
    expect(lead.data.pendingTap).toMatchObject({ id: tap.data.intentId, channel: 'PHONE_NATIVE' });

    const defaults = await json(await app.api('/interactions/defaults'));
    expect(defaults.ok).toBe(true);
    const phone = defaults.data.channels.find((c: { code: string }) => c.code === 'PHONE_NATIVE');
    const codes = phone.outcomes.map((o: { code: string }) => o.code);
    expect(codes).toEqual(expect.arrayContaining(['NO_ANSWER', 'CONNECTED_INTERESTED']));
    expect(codes).not.toContain('MEETING_HELD');

    const logged = await json(
      await app.api('/interactions', {
        method: 'POST',
        body: {
          leadId: exec1Lead,
          idempotencyKey: crypto.randomUUID(),
          version: lead.data.lead.version,
          channel: 'PHONE_NATIVE',
          direction: 'OUTBOUND',
          outcome: 'NO_ANSWER',
          occurredAt: lead.data.pendingTap.occurredAt,
          notes: 'from the app',
        },
      }),
    );
    expect(logged.ok, JSON.stringify(logged)).toBe(true);
    expect((await json(await app.api(`/leads/${exec1Lead}`))).data.pendingTap).toBeNull();
  });

  it('invalid input is a 422 with field errors, not a crash', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    const res = await app.api('/interactions', { method: 'POST', body: { leadId: exec1Lead } });
    expect(res.status).toBe(422);
    expect((await json(res)).error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('assignment from the app (FR-063/070/072/073)', () => {
  let team: string;
  const mine = async (user: { email: string }, name: string) => {
    const a = await actorIn(user as Parameters<typeof actorIn>[0], A.orgId);
    return created(
      leads.createLead(a.ctx, { fullName: name, primaryPhone: `98111${randomInt(10000, 99999)}` }),
    );
  };
  const lead = async (app: App, id: string) =>
    (await json(await app.api(`/leads/${id}`))).data.lead;
  /** An owner-created lead moved to the org queue (unassigned), as an import or a handover leaves it. */
  const queued = async (owner: App, name: string) => {
    const id = await mine(A.users.owner, name);
    const v = (await lead(owner, id)).version;
    const r = await owner.api(`/leads/${id}/assign`, {
      method: 'POST',
      body: { target: 'queue', version: v, reason: 'to the queue' },
    });
    expect(r.status).toBe(200);
    return id;
  };

  beforeAll(async () => {
    const owner = await actorIn(A.users.owner, A.orgId);
    team = (await teams.createTeam(owner.ctx, { name: 'App Marina' })).id;
    for (const [m, teamRole] of [
      [A.membership.manager!, 'LEAD'],
      [A.membership.exec1!, 'MEMBER'],
      [A.membership.exec2!, 'MEMBER'],
    ] as const)
      await teams.addTeamMember(owner.ctx, { teamId: team, membershipId: m, teamRole });
  });

  it('the owner sees every person and team as a target; executives and HR cannot assign', async () => {
    const owner = await appFor(A.users.owner, A.orgId);
    const t = await json(await owner.api('/assignment-targets'));
    expect(t.data.orgQueue).toBe(true);
    const people = t.data.people.map((p: { userId: string }) => p.userId);
    expect(people).toEqual(expect.arrayContaining([A.users.exec1.id, A.users.exec2.id]));
    expect(people).not.toContain(B.users.exec1.id);
    expect(t.data.teams.map((x: { id: string }) => x.id)).toContain(team);
    for (const k of ['exec1', 'hr'] as const) {
      const app = await appFor(A.users[k], A.orgId);
      expect((await app.api('/assignment-targets')).status, k).toBe(403);
    }
  });

  it('the owner reassigns a lead with a reason; without one it is refused', async () => {
    const owner = await appFor(A.users.owner, A.orgId);
    const id = await mine(A.users.exec1, 'Reassign Me');
    const v = (await lead(owner, id)).version;
    const noReason = await owner.api(`/leads/${id}/assign`, {
      method: 'POST',
      body: { target: `user:${A.users.exec2.id}`, version: v },
    });
    expect(noReason.status).toBe(422);
    expect((await json(noReason)).error?.code).toBe('VALIDATION_FAILED');
    const ok = await owner.api(`/leads/${id}/assign`, {
      method: 'POST',
      body: { target: `user:${A.users.exec2.id}`, version: v, reason: 'Arabic speaker' },
    });
    expect(ok.status).toBe(200);
    expect((await lead(owner, id)).ownerUserId).toBe(A.users.exec2.id);
    // A stale version (the screen was out of date) is a conflict, not a silent overwrite.
    const stale = await owner.api(`/leads/${id}/assign`, {
      method: 'POST',
      body: { target: `user:${A.users.exec1.id}`, version: v, reason: 'again' },
    });
    expect(stale.status).toBe(409);
  });

  it('an executive cannot assign, even their own lead', async () => {
    const exec = await appFor(A.users.exec1, A.orgId);
    const id = await mine(A.users.exec1, 'Exec Keeps');
    const v = (await lead(exec, id)).version;
    const r = await exec.api(`/leads/${id}/assign`, {
      method: 'POST',
      body: { target: `user:${A.users.exec2.id}`, version: v, reason: 'x' },
    });
    expect(r.status).toBe(403);
  });

  it('no assigning across organisations', async () => {
    const owner = await appFor(A.users.owner, A.orgId);
    const r1 = await owner.api(`/leads/${bLead}/assign`, {
      method: 'POST',
      body: { target: `user:${A.users.exec1.id}`, version: 1, reason: 'x' },
    });
    expect(r1.status).toBe(404);
    const id = await mine(A.users.exec1, 'Stay Home');
    const r2 = await owner.api(`/leads/${id}/assign`, {
      method: 'POST',
      body: {
        target: `user:${B.users.exec1.id}`,
        version: (await lead(owner, id)).version,
        reason: 'x',
      },
    });
    expect(r2.status).toBe(422);
    const r3 = await owner.api('/leads/assign', {
      method: 'POST',
      body: { leadIds: [bLead], target: `user:${A.users.exec1.id}` },
    });
    expect(r3.status).toBe(404);
  });

  it('queue: the owner lists unassigned leads, then bulk-assigns and deals round-robin', async () => {
    const owner = await appFor(A.users.owner, A.orgId);
    const q1 = await queued(owner, 'Queue One');
    const q2 = await queued(owner, 'Queue Two');
    const q3 = await queued(owner, 'Queue Three');
    const list = await json(await owner.api('/leads?owner=none&sort=oldest'));
    const ids = list.data.rows.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([q1, q2, q3]));
    expect(ids).not.toContain(exec1Lead);

    const bulk = await json(
      await owner.api('/leads/assign', {
        method: 'POST',
        body: { leadIds: [q1], target: `user:${A.users.exec1.id}` },
      }),
    );
    expect(bulk.data).toEqual({ moved: 1 });
    expect((await lead(owner, q1)).ownerUserId).toBe(A.users.exec1.id);

    const rr = await json(
      await owner.api('/leads/round-robin', {
        method: 'POST',
        body: { leadIds: [q2, q3], teamId: team },
      }),
    );
    expect(rr.ok, JSON.stringify(rr)).toBe(true);
    const owners = new Set(rr.data.assigned.map((a: { userId: string }) => a.userId));
    for (const u of owners)
      expect([A.users.manager.id, A.users.exec1.id, A.users.exec2.id]).toContain(u);
    const after = (await json(await owner.api('/leads?owner=none'))).data.rows.map(
      (r: { id: string }) => r.id,
    );
    expect(after).not.toEqual(expect.arrayContaining([q2]));
  });

  it('a sales manager assigns within the team they lead, never outside it', async () => {
    const mgr = await appFor(A.users.manager, A.orgId);
    const t = await json(await mgr.api('/assignment-targets'));
    expect(t.data.orgQueue).toBe(false);
    expect(t.data.teams.map((x: { id: string }) => x.id)).toEqual([team]);
    expect(t.data.people.map((p: { userId: string }) => p.userId)).not.toContain(A.users.hr.id);
    const id = await mine(A.users.exec1, 'Team Lead Move');
    const v = (await lead(mgr, id)).version;
    const ok = await mgr.api(`/leads/${id}/assign`, {
      method: 'POST',
      body: { target: `user:${A.users.exec2.id}`, version: v, reason: 'workload' },
    });
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    const out = await mgr.api(`/leads/${id}/assign`, {
      method: 'POST',
      body: {
        target: `user:${A.users.admin.id}`,
        version: (await lead(mgr, id)).version,
        reason: 'x',
      },
    });
    expect(out.status).toBe(422);
  });
});

describe('notifications in the app (FR-118)', () => {
  const notify = (orgId: string, userId: string, title: string) =>
    migrator().notification.create({
      data: {
        orgId,
        recipientUserId: userId,
        type: 'LEAD_ASSIGNED',
        title,
        body: 'b',
        link: `/app/leads/${exec1Lead}`,
      },
    });

  it('lists only my notifications, with the unread count, and marks them read', async () => {
    const mine = await notify(A.orgId, A.users.exec1.id, 'App notice for exec1');
    const theirs = await notify(A.orgId, A.users.exec2.id, 'App notice for exec2');
    const other = await notify(B.orgId, B.users.exec1.id, 'App notice in B');
    const app = await appFor(A.users.exec1, A.orgId);

    const list = await json(await app.api('/notifications'));
    expect(list.ok).toBe(true);
    const titles = list.data.rows.map((r: { title: string }) => r.title);
    expect(titles).toContain('App notice for exec1');
    expect(titles).not.toContain('App notice for exec2');
    expect(titles).not.toContain('App notice in B');
    expect(list.data.unread).toBeGreaterThanOrEqual(1);
    const before = list.data.unread as number;

    // Someone else's notification, or one in another organisation, is "not found".
    for (const n of [theirs, other])
      expect((await app.api(`/notifications/${n.id}/read`, { method: 'POST' })).status).toBe(404);

    const read = await json(await app.api(`/notifications/${mine.id}/read`, { method: 'POST' }));
    expect(read.data.unread).toBe(before - 1);
    const all = await json(await app.api('/notifications/read-all', { method: 'POST' }));
    expect(all.data.unread).toBe(0);
    expect((await json(await app.api('/me'))).data.active.unreadNotifications).toBe(0);
    // exec2's stays unread.
    expect(
      (await migrator().notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt,
    ).toBeNull();
  });
});

describe('phone push registration (ADR-0027 slice 5)', () => {
  const fcmToken = () => `e2e${randomInt(100000, 999999)}:APA91b${'x'.repeat(60)}`;

  it('registers and removes this phone for the signed-in member only', async () => {
    const t = fcmToken();
    const app = await appFor(A.users.exec1, A.orgId);
    const reg = await app.api('/push-devices', { method: 'POST', body: { token: t } });
    expect(reg.status, JSON.stringify(await reg.clone().json())).toBe(200);
    expect(await migrator().pushDevice.findUnique({ where: { token: t } })).toMatchObject({
      orgId: A.orgId,
      userId: A.users.exec1.id,
    });
    // Someone else cannot remove it.
    const other = await appFor(A.users.exec2, A.orgId);
    await other.api('/push-devices', { method: 'DELETE', body: { token: t } });
    expect(await migrator().pushDevice.findUnique({ where: { token: t } })).not.toBeNull();
    // Sign-out removes it.
    expect((await app.api('/push-devices', { method: 'DELETE', body: { token: t } })).status).toBe(
      200,
    );
    expect(await migrator().pushDevice.findUnique({ where: { token: t } })).toBeNull();
  });

  it('refuses a malformed token and a caller without a token', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    const bad = await app.api('/push-devices', { method: 'POST', body: { token: 'no' } });
    expect(bad.status).toBe(422);
    const anon = new App();
    expect(
      (await anon.api('/push-devices', { method: 'POST', body: { token: fcmToken() } })).status,
    ).toBe(401);
  });
});

describe('visits and My Day actions in the app (1.0.3)', () => {
  /** An org-local datetime-local value `minutes` from now (the seeded org is Asia/Kolkata). */
  const local = (minutes: number) =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'short',
      timeStyle: 'short',
    })
      .format(new Date(Date.now() + minutes * 60_000))
      .replace(' ', 'T');

  it('an executive lists and confirms their visit; another executive and another org cannot', async () => {
    const e1 = await actorIn(A.users.exec1, A.orgId);
    const lead = await created(
      leads.createLead(e1.ctx, {
        fullName: 'Visit Mobile',
        primaryPhone: '9811100021',
        // Requirements make the lead qualifiable, which scheduling a visit needs.
        transactionType: 'BUY',
        propertyType: 'APARTMENT',
        preferredCity: 'Dubai',
        budgetMax: '2M',
      }),
    );
    const { id } = await visits.scheduleVisit(e1.ctx, lead, {
      scheduledFor: local(3 * 24 * 60),
      location: 'Synthetic tower lobby',
    });
    const app = await appFor(A.users.exec1, A.orgId);
    const list = await json(await app.api('/visits'));
    expect(list.ok, JSON.stringify(list)).toBe(true);
    const mine = list.data.open.find((v: { id: string }) => v.id === id);
    expect(mine).toMatchObject({ canManage: true, lead: { id: lead }, outcomeDue: false });
    expect(mine.scheduledForLocal).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);

    // Missing reason: 422 with the field; then confirm with the version.
    const noReason = await app.api(`/visits/${id}`, {
      method: 'POST',
      body: { action: 'cancel', version: mine.version },
    });
    expect(noReason.status).toBe(422);
    const ok = await json(
      await app.api(`/visits/${id}`, {
        method: 'POST',
        body: { action: 'confirm', version: mine.version, orgId: B.orgId },
      }),
    );
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(
      (await json(await app.api('/visits'))).data.open.find((v: { id: string }) => v.id === id)
        .status,
    ).toBe('CONFIRMED');

    const other = await appFor(A.users.exec2, A.orgId);
    expect(
      (await json(await other.api('/visits'))).data.open.map((v: { id: string }) => v.id),
    ).not.toContain(id);
    expect(
      (
        await other.api(`/visits/${id}`, {
          method: 'POST',
          body: { action: 'confirm', version: 2 },
        })
      ).status,
    ).toBe(404);
    const bApp = await appFor(B.users.owner, B.orgId);
    expect(
      (
        await bApp.api(`/visits/${id}`, {
          method: 'POST',
          body: { action: 'cancel', version: 2, reason: 'x' },
        })
      ).status,
    ).toBe(404);
  });

  it('an executive reschedules their follow-up from My Day; others cannot', async () => {
    const e1 = await actorIn(A.users.exec1, A.orgId);
    const lead = await created(
      leads.createLead(e1.ctx, { fullName: 'Follow Mobile', primaryPhone: '9811100022' }),
    );
    await tasks.scheduleFollowUp(e1.ctx, lead, { dueAt: local(24 * 60) });
    const app = await appFor(A.users.exec1, A.orgId);
    const day = (await json(await app.api('/my-day'))).data;
    const item = [...day.today, ...day.upcoming].find(
      (t: { lead: { id: string } | null }) => t.lead?.id === lead,
    );
    expect(item).toMatchObject({ canUpdateOnLead: true, onLead: true });
    expect(item.dueAtLocal).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);

    const other = await appFor(A.users.exec2, A.orgId);
    expect(
      (
        await other.api(`/tasks/${item.id}/reschedule`, {
          method: 'POST',
          body: { dueAt: local(2 * 24 * 60), version: item.version },
        })
      ).status,
    ).toBe(404);

    const moved = await json(
      await app.api(`/tasks/${item.id}/reschedule`, {
        method: 'POST',
        body: { dueAt: local(2 * 24 * 60), version: item.version },
      }),
    );
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    const done = await json(
      await app.api(`/tasks/${item.id}/complete`, {
        method: 'POST',
        body: { version: item.version + 1 },
      }),
    );
    expect(done.ok, JSON.stringify(done)).toBe(true);
  });
});

describe('lead screen parity in the app (1.0.4)', () => {
  const local = (minutes: number) =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'short',
      timeStyle: 'short',
    })
      .format(new Date(Date.now() + minutes * 60_000))
      .replace(' ', 'T');
  const qualifiable = {
    transactionType: 'BUY',
    propertyType: 'APARTMENT',
    preferredCity: 'Dubai',
    budgetMax: '2M',
  };

  it('the sheet defaults carry every channel, both directions and the requirement choices', async () => {
    const app = await appFor(A.users.exec1, A.orgId);
    const d = (await json(await app.api('/interactions/defaults'))).data;
    expect(d.channels.map((c: { code: string }) => c.code)).toEqual([
      'PHONE_NATIVE',
      'WHATSAPP_APP_CALL',
      'WHATSAPP_APP_MESSAGE',
    ]);
    const email = d.allChannels.find((c: { code: string }) => c.code === 'EMAIL');
    expect(email).toMatchObject({ durationAllowed: false });
    expect(email.inbound.length).toBeGreaterThan(0);
    expect(d.directions.map((x: { code: string }) => x.code)).toEqual(['OUTBOUND', 'INBOUND']);
    expect(d.requirementOptions.intent.map((x: { code: string }) => x.code)).toEqual([
      'HOT',
      'WARM',
      'COLD',
    ]);
  });

  it('an executive logs an inbound outcome with requirements and a titled follow-up', async () => {
    const e1 = await actorIn(A.users.exec1, A.orgId);
    const lead = await created(
      leads.createLead(e1.ctx, { fullName: 'Parity Mobile', primaryPhone: '9811100031' }),
    );
    const app = await appFor(A.users.exec1, A.orgId);
    const detail = (await json(await app.api(`/leads/${lead}`))).data;
    // An outcome the server allows for an inbound email, as the app picks it.
    const defaults = (await json(await app.api('/interactions/defaults'))).data;
    const inbound = defaults.allChannels.find((c: { code: string }) => c.code === 'EMAIL')
      .inbound[0].code as string;
    expect(detail.nowLocal).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
    const r = await json(
      await app.api('/interactions', {
        method: 'POST',
        body: {
          leadId: lead,
          idempotencyKey: crypto.randomUUID(),
          version: detail.lead.version,
          channel: 'EMAIL',
          direction: 'INBOUND',
          outcome: inbound,
          occurredAt: local(-30),
          notes: 'Asked for floor plans',
          preferredCity: 'Abu Dhabi',
          requirementFields: 'preferredCity',
          nextDueAt: local(24 * 60),
          nextTitle: 'Send floor plans',
        },
      }),
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = (await json(await app.api(`/leads/${lead}`))).data;
    expect(after.lead.preferredCity).toBe('Abu Dhabi');
    expect(after.followUps.open[0]).toMatchObject({ title: 'Send floor plans' });
  });

  it('an executive books a visit and changes stage; others are refused', async () => {
    const e1 = await actorIn(A.users.exec1, A.orgId);
    const lead = await created(
      leads.createLead(e1.ctx, {
        fullName: 'Stage Mobile',
        primaryPhone: '9811100032',
        ...qualifiable,
      }),
    );
    const app = await appFor(A.users.exec1, A.orgId);
    let d = (await json(await app.api(`/leads/${lead}`))).data;
    expect(d.stage.targets.map((t: { code: string }) => t.code)).toContain('QUALIFIED');
    expect(d.stage.lostReasons.length).toBeGreaterThan(0);
    expect(d.visits.canSchedule).toBe(true);
    expect(d.visitPeople).toEqual([]); // executives book for themselves

    const q = await json(
      await app.api(`/leads/${lead}/stage`, {
        method: 'POST',
        body: { toStage: 'QUALIFIED', version: d.lead.version },
      }),
    );
    expect(q.ok, JSON.stringify(q)).toBe(true);

    const noPlace = await app.api(`/leads/${lead}/visits`, {
      method: 'POST',
      body: { scheduledFor: local(2 * 24 * 60), location: '' },
    });
    expect(noPlace.status).toBe(422);
    const booked = await json(
      await app.api(`/leads/${lead}/visits`, {
        method: 'POST',
        body: { scheduledFor: local(2 * 24 * 60), location: 'Marina tower lobby' },
      }),
    );
    expect(booked.ok, JSON.stringify(booked)).toBe(true);
    d = (await json(await app.api(`/leads/${lead}`))).data;
    expect(d.lead.stage).toBe('SITE_VISIT_SCHEDULED');
    expect(d.visits.visits[0]).toMatchObject({ id: booked.data.id, canManage: true });

    // Lost needs a reason.
    const lost = await app.api(`/leads/${lead}/stage`, {
      method: 'POST',
      body: { toStage: 'LOST', version: d.lead.version },
    });
    expect([422]).toContain(lost.status);

    const other = await appFor(A.users.exec2, A.orgId);
    for (const [path, body] of [
      [`/leads/${lead}/stage`, { toStage: 'QUALIFIED', version: d.lead.version, reasonText: 'x' }],
      [`/leads/${lead}/visits`, { scheduledFor: local(3 * 24 * 60), location: 'Elsewhere' }],
    ] as const)
      expect((await other.api(path, { method: 'POST', body })).status).toBe(404);
    const bApp = await appFor(B.users.owner, B.orgId);
    expect(
      (
        await bApp.api(`/leads/${lead}/visits`, {
          method: 'POST',
          body: { scheduledFor: local(3 * 24 * 60), location: 'Elsewhere' },
        })
      ).status,
    ).toBe(404);
  });
});
