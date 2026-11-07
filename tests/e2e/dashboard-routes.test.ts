// FR-130–133 dashboards over HTTP against the built server: a team or person filter outside the
// viewer's scope (or an unknown or another org's person) is refused with a plain page — no
// figure, no record, no 500 — while in-scope filters keep working. Malformed values and missing
// lead sources get their own plain page; an unknown report stays a 404. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as teams from '@/modules/teams';
import { migrator } from '../support/db';
import { actorIn, PASSWORD, seedOrg } from '../support/factory';
import { Browser } from './http';

const REFUSED = 'You can only filter by teams and people within your reporting scope';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let sourceA: string;
let sourceB: string;

async function browserFor(user: { email: string }, orgId: string): Promise<Browser> {
  const b = new Browser();
  expect((await b.signIn(user.email, PASSWORD)).status).toBe(200);
  expect((await b.authPost('/organization/set-active', { organizationId: orgId })).status).toBe(
    200,
  );
  return b;
}
async function page(b: Browser, path: string) {
  const res = await b.get(path);
  return { status: res.status, html: (await res.text()).replace(/<!-- -->/g, '') };
}
async function created(r: Promise<leads.CreateLeadResult>) {
  const v = await r;
  if (v.status !== 'created') throw new Error('expected a new lead');
  return v.leadId;
}

beforeAll(async () => {
  A = await seedOrg('DashRouteA');
  B = await seedOrg('DashRouteB');
  const owner = await actorIn(A.users.owner, A.orgId);
  const west = (await teams.createTeam(owner.ctx, { name: 'West' })).id;
  await teams.addTeamMember(owner.ctx, {
    teamId: west,
    membershipId: A.membership.manager!,
    teamRole: 'LEAD',
  });
  await teams.addTeamMember(owner.ctx, {
    teamId: west,
    membershipId: A.membership.exec1!,
    teamRole: 'MEMBER',
  });
  const exec1 = await actorIn(A.users.exec1, A.orgId);
  const exec2 = await actorIn(A.users.exec2, A.orgId);
  const execB = await actorIn(B.users.exec1, B.orgId);
  await created(
    leads.createLead(exec1.ctx, { fullName: 'Westerly Lead', primaryPhone: '9844441111' }),
  );
  await created(
    leads.createLead(exec2.ctx, { fullName: 'Outsider Lead', primaryPhone: '9844442222' }),
  );
  const foreign = await created(
    leads.createLead(execB.ctx, { fullName: 'Foreign Lead', primaryPhone: '9844443333' }),
  );
  const sourceOf = async (fullName: string, orgId: string) =>
    (await migrator().lead.findFirstOrThrow({ where: { orgId, fullName } })).sourceId;
  sourceA = await sourceOf('Westerly Lead', A.orgId);
  sourceB = (await migrator().lead.findUniqueOrThrow({ where: { id: foreign } })).sourceId;
});

const INVALID = 'This filter cannot be used';
/** A malformed or missing filter: a plain page naming the problem, and no figure or record. */
const invalid = (r: { status: number; html: string }, path: string, message: string) => {
  expect(r.status, path).toBe(200);
  expect(r.html, path).toContain(`${INVALID}: ${message}`);
  expect(r.html, path).not.toContain(REFUSED);
  expect(r.html, path).not.toContain('data-testid="kpi-tile"');
  expect(r.html, path).not.toContain('data-testid="drill-row"');
  for (const name of ['Westerly Lead', 'Outsider Lead', 'Foreign Lead'])
    expect(r.html, path).not.toContain(name);
};

const refused = (r: { status: number; html: string }, path: string) => {
  expect(r.status, path).toBe(200);
  expect(r.html, path).toContain(REFUSED);
  expect(r.html, path).not.toContain('data-testid="kpi-tile"');
  expect(r.html, path).not.toContain('data-testid="drill-row"');
  for (const name of ['Westerly Lead', 'Outsider Lead', 'Foreign Lead'])
    expect(r.html, path).not.toContain(name);
};

describe('dashboard filters outside the scope', () => {
  it('Manager: refused on the dashboard and drill-downs, alike for unknown and other-org people', async () => {
    const b = await browserFor(A.users.manager, A.orgId);
    for (const user of [A.users.exec2.id, randomUUID(), B.users.exec1.id])
      for (const path of [
        `/app/dashboard?user=${user}`,
        `/app/dashboard/k01-new?user=${user}`,
        `/app/dashboard/open-by-stage?stage=NEW&user=${user}`,
      ])
        refused(await page(b, path), path);
    // In scope: the led team's member.
    const ok = await page(b, `/app/dashboard/k01-new?user=${A.users.exec1.id}`);
    expect(ok.status).toBe(200);
    expect(ok.html).not.toContain(REFUSED);
    expect(ok.html).toContain('Westerly Lead');
    expect(ok.html).not.toContain('Outsider Lead');
    const dash = await page(b, `/app/dashboard?user=${A.users.exec1.id}`);
    expect(dash.status).toBe(200);
    expect(dash.html).toContain('Team dashboard');
  });

  it('Executive: refused on the dashboard and drill-downs; their own view still works', async () => {
    const b = await browserFor(A.users.exec1, A.orgId);
    for (const user of [A.users.exec2.id, A.users.manager.id, randomUUID(), B.users.exec1.id])
      for (const path of [`/app/dashboard?user=${user}`, `/app/dashboard/k01-new?user=${user}`])
        refused(await page(b, path), path);
    refused(await page(b, `/app/dashboard?team=${randomUUID()}`), 'team filter');
    const own = await page(b, '/app/dashboard/k01-new');
    expect(own.status).toBe(200);
    expect(own.html).toContain('Westerly Lead');
    expect(own.html).not.toContain('Outsider Lead');
    expect(own.html).not.toContain('Foreign Lead');
    const dash = await page(b, '/app/dashboard');
    expect(dash.status).toBe(200);
    expect(dash.html).toContain('My dashboard');
  });

  it('an unknown report stays a 404', async () => {
    const b = await browserFor(A.users.exec1, A.orgId);
    expect((await b.get(`/app/dashboard/k99?user=${A.users.exec2.id}`)).status).toBe(404);
    expect((await b.get('/app/dashboard/k99?source=abc')).status).toBe(404);
  });
});

describe('malformed and missing dashboard filters', () => {
  for (const role of ['manager', 'exec1'] as const)
    it(`${role}: a named problem instead of a 500, a refusal or a 404; valid filters still work`, async () => {
      const b = await browserFor(A.users[role], A.orgId);
      for (const base of ['/app/dashboard', '/app/dashboard/k01-new']) {
        invalid(await page(b, `${base}?user=abc`), `${base} user`, 'Choose a valid person');
        invalid(await page(b, `${base}?team=abc`), `${base} team`, 'Choose a valid team');
        invalid(
          await page(b, `${base}?source=abc`),
          `${base} source`,
          'Choose a valid lead source',
        );
        invalid(
          await page(b, `${base}?user=${'x'.repeat(41)}`),
          `${base} long`,
          'Choose valid report filters',
        );
        // An unknown source and another organisation's source look the same.
        for (const source of [randomUUID(), sourceB])
          invalid(
            await page(b, `${base}?source=${source}`),
            `${base} ${source}`,
            'Lead source not found',
          );
        // An unknown team stays a refusal: no signal whether it exists anywhere.
        refused(await page(b, `${base}?team=${randomUUID()}`), `${base} unknown team`);
      }
      // A valid source still filters, within the viewer's scope only.
      const ok = await page(
        b,
        `/app/dashboard/k01-new?source=${sourceA}${role === 'manager' ? `&user=${A.users.exec1.id}` : ''}`,
      );
      expect(ok.status).toBe(200);
      expect(ok.html).not.toContain(INVALID);
      expect(ok.html).toContain('Westerly Lead');
      expect(ok.html).not.toContain('Outsider Lead');
      expect(ok.html).not.toContain('Foreign Lead');
    });
});
