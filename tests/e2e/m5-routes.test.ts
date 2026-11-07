// Phase 2 M5 acceptance over HTTP against the BUILT server, the real worker and the local fake of
// the Storage API (no cloud): archive/restore and the archive view, bulk archive, duplicate
// detection and review (incl. a concurrent resolution), merge preview and choices, custom fields
// (settings, manual create, forged values), exports (request → worker → single download →
// expiry → cleanup), cross-organisation isolation, unauthorised roles, suspended users, and no
// secret or personal-data leakage in responses. Synthetic data only; crm_test only.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sweepExportFiles } from '@/modules/exports/cleanup';
import * as leads from '@/modules/leads';
import { exportFilesDue, markExportFileDeleted } from '@/platform/db/cleanup';
import { createSupabaseStorage } from '@/platform/storage/supabase';
import { migrator } from '../support/db';
import { actorIn, PASSWORD, seedOrg } from '../support/factory';
import { E2E_BUCKET, E2E_STORAGE_KEY, E2E_STORAGE_URL } from './fake-storage';
import { BASE, Browser } from './http';

const L = 'src/modules/leads/actions.ts';
const X = 'src/modules/exports/actions.ts';
type Org = Awaited<ReturnType<typeof seedOrg>>;
let A: Org;
let B: Org;
const br = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'ownerB', Browser>;
const storage = createSupabaseStorage({
  url: E2E_STORAGE_URL,
  serviceKey: E2E_STORAGE_KEY,
  bucket: E2E_BUCKET,
});

let seq = 0;
const phone = () => `87${String(90_000_000 + ++seq * 6_053 + (process.pid % 1000)).slice(-8)}`;
const html = async (res: Response) => (await res.text()).replace(/<!-- -->/g, '');

async function browserFor(user: { email: string }, orgId: string): Promise<Browser> {
  const b = new Browser();
  expect((await b.signIn(user.email, PASSWORD)).status).toBe(200);
  expect((await b.authPost('/organization/set-active', { organizationId: orgId })).status).toBe(
    200,
  );
  return b;
}
async function created(by: Org['users']['owner'], org: Org, input: Record<string, unknown> = {}) {
  const r = await leads.createLead((await actorIn(by, org.orgId)).ctx, {
    fullName: 'Synthetic Customer',
    primaryPhone: phone(),
    ...input,
  });
  if (r.status !== 'created') throw new Error('expected created');
  return r.leadId;
}
const version = async (id: string) =>
  String((await migrator().lead.findUniqueOrThrow({ where: { id } })).version);

beforeAll(async () => {
  A = await seedOrg('E2EM5A');
  B = await seedOrg('E2EM5B');
  br.owner = await browserFor(A.users.owner, A.orgId);
  br.admin = await browserFor(A.users.admin, A.orgId);
  br.manager = await browserFor(A.users.manager, A.orgId);
  br.exec1 = await browserFor(A.users.exec1, A.orgId);
  br.ownerB = await browserFor(B.users.owner, B.orgId);
});

describe('archive, restore and the archive view', () => {
  it('Owner archives with the shown version; stale and unauthorised attempts are refused', async () => {
    const id = await created(A.users.exec1, A, { fullName: 'Synthetic Archive Me' });
    const page = `/app/leads/${id}`;
    // Lead actions sit near the top, before the contact card (M5 §K), for those allowed.
    const active = await html(await br.owner.get(page));
    const bar = active.indexOf('aria-label="Lead actions"');
    expect(bar).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(active.indexOf('>Contact<'));
    const barHtml = active.slice(bar, active.indexOf('</section>', bar));
    expect(barHtml).toContain('Archive lead');
    expect(barHtml).toContain('href="#merge"');
    expect(active).toContain('id="merge"');
    expect(await html(await br.exec1.get(page))).not.toContain('aria-label="Lead actions"');
    // Every top-level destination is in the phone menu (a disclosure), not a sideways scroller.
    const menu = active.slice(active.indexOf('<details'), active.indexOf('</details>'));
    expect(menu).toContain('<summary');
    for (const href of ['/app/leads', '/app/settings/custom-fields', '/app/settings/audit'])
      expect(menu).toContain(`href="${href}"`);
    expect(active).not.toMatch(/<nav[^>]*overflow-x-auto/);
    // Permission-based visibility is unchanged: a Sales Executive's menu has no settings link.
    expect(await html(await br.exec1.get(page))).not.toContain(
      'href="/app/settings/custom-fields"',
    );
    expect(
      await br.exec1.action(page, L, 'archiveLeadAction', {
        leadId: id,
        version: await version(id),
      }),
    ).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(
      await br.owner.action(page, L, 'archiveLeadAction', { leadId: id, version: '99' }),
    ).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    });
    expect(
      await br.owner.action(page, L, 'archiveLeadAction', {
        leadId: id,
        version: await version(id),
      }),
    ).toMatchObject({
      ok: true,
    });
    const detail = await html(await br.owner.get(page));
    expect(detail).toContain('Archived');
    expect(detail).toContain('Restore lead');
    // Restore is in the top actions bar; merge is not offered for an archived lead.
    const archivedBar = detail.slice(detail.indexOf('aria-label="Lead actions"'));
    expect(archivedBar.slice(0, archivedBar.indexOf('</section>'))).toContain('Restore lead');
    expect(detail).not.toContain('href="#merge"');
    expect(await html(await br.owner.get('/app/leads?q=Archive+Me'))).not.toContain(
      'Synthetic Archive Me',
    );
    expect(await html(await br.owner.get('/app/leads?q=Archive+Me&archived=archived'))).toContain(
      'Synthetic Archive Me',
    );
    // Read-only while archived, even through a forged action.
    expect(
      await br.owner.action(page, L, 'addNoteAction', { leadId: id, body: 'x' }),
    ).toMatchObject({
      ok: false,
      code: 'RULE_VIOLATION',
    });
    // A stale page archiving again is told it is a conflict (the page then refreshes, M5 U2).
    const stale = await br.admin.action(page, L, 'archiveLeadAction', { leadId: id, version: '1' });
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(stale.body).toContain('This lead is already archived');
    // A new enquiry with the archived lead's phone is reported as an archived match (M5 U9).
    const { primaryPhoneE164 } = await migrator().lead.findUniqueOrThrow({ where: { id } });
    const dup = await br.owner.action('/app/leads/new', L, 'createLeadAction', {
      fullName: 'Synthetic Archive Me',
      primaryPhone: primaryPhoneE164,
    });
    expect(dup).toMatchObject({
      ok: true,
      data: { status: 'duplicate', leadId: id, archived: true },
    });
    expect(
      await br.admin.action(page, L, 'restoreLeadAction', {
        leadId: id,
        version: await version(id),
      }),
    ).toMatchObject({
      ok: true,
    });
  });

  it('bulk archive: Owner/Admin only, exact items, refused for another org’s lead', async () => {
    const [x, y] = [await created(A.users.exec1, A), await created(A.users.exec1, A)];
    const theirs = await created(B.users.owner, B);
    const items = { item: `${x}:${await version(x)}` };
    expect(await br.manager.action('/app/leads', L, 'bulkArchiveAction', items)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(
      await br.owner.action('/app/leads', L, 'bulkArchiveAction', {
        item: `${theirs}:${await version(theirs)}`,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const res = await br.owner.action('/app/leads', L, 'bulkArchiveAction', items);
    expect(res).toMatchObject({ ok: true });
    expect(
      (await migrator().lead.findUniqueOrThrow({ where: { id: x } })).archivedAt,
    ).not.toBeNull();
    expect((await migrator().lead.findUniqueOrThrow({ where: { id: y } })).archivedAt).toBeNull();
    expect(
      (await migrator().lead.findUniqueOrThrow({ where: { id: theirs } })).archivedAt,
    ).toBeNull();
  });
});

describe('duplicate detection and review', () => {
  it('a manual create with an existing email raises a case; deciders see it; others get 404', async () => {
    const first = await created(A.users.exec1, A, {
      email: 'synthetic.e2edup@example.test',
      fullName: 'Synthetic Dup One',
    });
    const r = await br.manager.action('/app/leads/new', L, 'createLeadAction', {
      fullName: 'Synthetic Dup Two',
      primaryPhone: phone(),
      email: 'SYNTHETIC.E2EDUP@example.test',
    });
    expect(r.body).not.toContain(first); // nothing about the other lead is revealed
    const c = await migrator().leadDuplicateMatch.findFirstOrThrow({
      where: { candidateLeadId: first, matchType: 'EMAIL' },
    });
    const queue = await html(await br.owner.get('/app/leads/review'));
    expect(queue).toContain('Same email address');
    expect(queue).toContain('Synthetic Dup One');
    expect((await br.exec1.get('/app/leads/review')).status).toBe(404);
    expect(await html(await br.ownerB.get('/app/leads/review'))).not.toContain('Synthetic Dup One');
    expect(
      await br.ownerB.action('/app/leads/review', L, 'resolveCaseAction', {
        caseId: c.id,
        decision: 'dismiss',
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    // Two people resolve at once: one decision is recorded, the other is told it was resolved.
    const both = await Promise.all([
      br.owner.action('/app/leads/review', L, 'resolveCaseAction', {
        caseId: c.id,
        decision: 'dismiss',
      }),
      br.admin.action('/app/leads/review', L, 'resolveCaseAction', {
        caseId: c.id,
        decision: 'dismiss',
      }),
    ]);
    expect(both.map((x) => (x.ok ? 'OK' : x.code)).sort()).toEqual(['CONFLICT', 'OK']);
    // The loser is sent to the queue with a notice naming the other decision (M5 U3); the notice
    // is scope-filtered (another org sees none) and ignores malformed ids.
    const notice = await html(await br.admin.get(`/app/leads/review?conflict=${c.id}`));
    expect(notice).toContain('Someone else decided this case first (Not duplicates');
    expect(notice).toContain('Your decision was not applied');
    expect(notice).toContain('Synthetic Dup One');
    const foreign = await html(await br.ownerB.get(`/app/leads/review?conflict=${c.id}`));
    expect(foreign).not.toContain('Someone else decided');
    expect(foreign).not.toContain('Synthetic Dup One');
    expect(await html(await br.admin.get('/app/leads/review?conflict=not-a-uuid'))).not.toContain(
      'Someone else decided',
    );
    // There is no UI decision that merges or restores a pair silently.
    expect(
      await br.owner.action('/app/leads/review', L, 'resolveCaseAction', {
        caseId: c.id,
        decision: 'merge',
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('merge', () => {
  it('preview lists conflicts; a merge without every choice is refused; with choices it merges by reference', async () => {
    const s = await created(A.users.exec1, A, {
      fullName: 'Synthetic Keep',
      email: 'synthetic.keep@example.test',
    });
    const m = await created(A.users.exec1, A, {
      fullName: 'Synthetic Drop',
      email: 'synthetic.drop@example.test',
    });
    await leads.addNote((await actorIn(A.users.exec1, A.orgId)).ctx, m, {
      body: 'Synthetic note on the duplicate',
    });
    const preview = await html(await br.owner.get(`/app/leads/merge?survivor=${s}&merged=${m}`));
    expect(preview).toContain('Conflicts (2)');
    expect(preview).toContain('History is preserved');
    // Neither lead has localities: no empty "Localities" item, and only the real fill (the
    // duplicate's phone for the empty alternate slot) is counted (M5 U5).
    expect(preview).not.toContain('Localities (combined)');
    expect(preview).toContain('Filled from the duplicate (1)');
    const withLoc = await created(A.users.exec1, A, {
      fullName: 'Synthetic Drop',
      email: 'synthetic.keep@example.test',
      preferredLocalities: 'Baner',
    });
    const locPreview = await html(
      await br.owner.get(`/app/leads/merge?survivor=${s}&merged=${withLoc}`),
    );
    expect(locPreview).toContain('Localities (combined)');
    expect(locPreview).toContain('Filled from the duplicate (2)');
    expect((await br.ownerB.get(`/app/leads/merge?survivor=${s}&merged=${m}`)).status).toBe(404);
    expect((await br.exec1.get(`/app/leads/merge?survivor=${s}&merged=${m}`)).status).toBe(404);
    const base = {
      survivorId: s,
      mergedId: m,
      survivorVersion: await version(s),
      mergedVersion: await version(m),
    };
    expect(await br.owner.action('/app/leads/merge', L, 'mergeLeadsAction', base)).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    const done = await br.owner.action('/app/leads/merge', L, 'mergeLeadsAction', {
      ...base,
      'keep.fullName': 'survivor',
      'keep.email': 'merged',
    });
    expect(done.ok).not.toBe(false); // success redirects to the surviving lead (no ActionResult)
    expect((await migrator().lead.findUniqueOrThrow({ where: { id: m } })).mergedIntoLeadId).toBe(
      s,
    );
    const survivor = await html(await br.owner.get(`/app/leads/${s}`));
    expect(survivor).toContain('Synthetic note on the duplicate');
    expect(survivor).toContain('from a merged lead');
    const tomb = await html(await br.owner.get(`/app/leads/${m}`));
    expect(tomb).toContain('This lead was merged into');
  });
});

describe('custom fields', () => {
  it('Owner manages fields; manual create enforces required and type rules on the server', async () => {
    expect((await br.exec1.get('/app/settings/custom-fields')).status).toBe(404);
    expect(
      await br.manager.action('/app/settings/custom-fields', L, 'createCustomFieldAction', {
        key: 'nope_field',
        label: 'Nope',
        type: 'text',
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    for (const f of [
      { key: 'e2e_city', label: 'E2E City', type: 'text', required: 'on' },
      { key: 'e2e_size', label: 'E2E Size', type: 'number' },
    ])
      expect(
        await br.owner.action('/app/settings/custom-fields', L, 'createCustomFieldAction', f),
      ).toMatchObject({
        ok: true,
      });
    expect(await html(await br.owner.get('/app/leads/new'))).toContain('E2E City (required)');
    const missing = await br.exec1.action('/app/leads/new', L, 'createLeadAction', {
      fullName: 'Synthetic CF',
      primaryPhone: phone(),
    });
    expect(missing).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    // An actionable message naming the field, not the schema library's text (M5 U8).
    expect(missing.body).toContain('E2E City is required');
    expect(missing.body).not.toMatch(/expected string|received undefined/);
    // Browser validation bypassed: a non-number for a number field is refused, not coerced.
    const forged = await br.exec1.action('/app/leads/new', L, 'createLeadAction', {
      fullName: 'Synthetic CF',
      primaryPhone: phone(),
      'cf.e2e_city': 'Pune',
      'cf.e2e_size': 'four',
      'cf.unknown_field': 'x',
    });
    expect(forged).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(forged.body).toContain('E2E Size: enter a number');
    const ok = await br.exec1.action('/app/leads/new', L, 'createLeadAction', {
      fullName: 'Synthetic CF Good',
      primaryPhone: phone(),
      'cf.e2e_city': 'Pune',
      'cf.e2e_size': '4',
    });
    expect(ok.ok).not.toBe(false); // success redirects to the new lead (no ActionResult)
    const lead = await migrator().lead.findFirstOrThrow({
      where: { orgId: A.orgId, fullName: 'Synthetic CF Good' },
    });
    expect(lead.customFields).toEqual({ e2e_city: 'Pune', e2e_size: 4 });
    // Clean up the required field so the other tests' manual creates are unaffected.
    const city = await migrator().customFieldDefinition.findFirstOrThrow({
      where: { orgId: A.orgId, key: 'e2e_city' },
    });
    expect(
      await br.owner.action('/app/settings/custom-fields', L, 'setCustomFieldArchivedAction', {
        fieldId: city.id,
        version: String(city.version),
        archived: 'true',
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('exports', () => {
  async function waitReady(id: string, ms = 30_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const j = await migrator().exportJob.findUniqueOrThrow({ where: { id } });
      if (j.status !== 'QUEUED' && j.status !== 'RUNNING') return j;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('export did not finish');
  }

  it('Owner request → worker → one checksum-matching download → 410; nobody else can see it', async () => {
    await created(A.users.exec1, A, {
      fullName: '=HYPERLINK("http://example.invalid")',
      preferredCity: 'E2E Town',
    });
    expect(
      await br.admin.action('/app/leads/exports', X, 'requestExportAction', { query: '' }),
    ).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect((await br.admin.get('/app/leads/exports')).status).toBe(404);
    const page = await html(await br.owner.get('/app/leads/exports?city=E2E+Town'));
    expect(page).toContain('At most 50,000 leads and 20 MB per file');
    const req = await br.owner.action('/app/leads/exports', X, 'requestExportAction', {
      query: 'city=E2E+Town&q=HYPERLINK',
    });
    expect(req).toMatchObject({ ok: true });
    const { id } = req.data as { id: string };
    const j = await waitReady(id);
    expect(j.status).toBe('READY');
    expect(j.filters).not.toHaveProperty('q');
    expect(j.storageKey).toMatch(new RegExp(`^orgs/${A.orgId}/exports/${id}/`));
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { action: 'lead.export_requested', entityId: id },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain('HYPERLINK');
    const list = await html(await br.owner.get('/app/leads/exports'));
    expect(list).toContain('Ready to download');
    expect(list).not.toContain(E2E_STORAGE_URL);
    expect(list).not.toContain(j.storageKey);
    expect(list).not.toContain(E2E_STORAGE_KEY);

    // Others: admin (not owner), another org, anonymous.
    expect((await br.admin.get(`/app/leads/exports/${id}/download`)).status).toBe(404);
    expect((await br.ownerB.get(`/app/leads/exports/${id}/download`)).status).toBe(404);
    // Anonymous: the app proxy sends every /app/* request to sign-in first (as for issues.csv).
    const anon = await new Browser().get(`/app/leads/exports/${id}/download`);
    expect([302, 303, 307]).toContain(anon.status);
    expect(anon.headers.get('location')).toMatch(/\/login/);

    const res = await br.owner.get(`/app/leads/exports/${id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = Buffer.from(await res.arrayBuffer());
    expect(createHash('sha256').update(body).digest().equals(Buffer.from(j.sha256!))).toBe(true);
    const text = body.toString('utf8');
    expect(text).toContain(`requested by ${A.users.owner.name}`);
    expect(text).toContain(`"'=HYPERLINK(""http://example.invalid"")"`);
    expect((await br.owner.get(`/app/leads/exports/${id}/download`)).status).toBe(410);
  });

  it('an expired export is refused (410) without waiting 15 minutes', async () => {
    // A finished job whose 15-minute window ended 5 minutes ago (inserted as the schema owner).
    const id = randomUUID();
    await migrator().$executeRaw`
      INSERT INTO export_job (id, org_id, requested_by, storage_key, status, created_at, started_at,
        finished_at, expires_at, row_count, sha256, purge_file_after)
      VALUES (${id}::uuid, ${A.orgId}::uuid, ${A.users.owner.id}::uuid,
        ${`orgs/${A.orgId}/exports/${id}/${randomBytes(16).toString('hex')}.csv`}, 'READY',
        now() - interval '25 minutes', now() - interval '21 minutes', now() - interval '20 minutes',
        now() - interval '5 minutes', 1, ${randomBytes(32)}, now() + interval '30 minutes')`;
    expect((await br.owner.get(`/app/leads/exports/${id}/download`)).status).toBe(410);
    expect(await html(await br.owner.get('/app/leads/exports'))).toContain('Expired');
  });

  it('cleanup (crm_cleanup) deletes a due file and closes the job', async () => {
    const req = await br.owner.action('/app/leads/exports', X, 'requestExportAction', {
      query: '',
    });
    const { id } = req.data as { id: string };
    const j = await waitReady(id);
    expect(await storage.stat(j.storageKey)).not.toBeNull();
    // Make it due: retention may only shrink, and (as the guard requires) in the same update the
    // window closes, since a READY job's window must end before its purge time.
    await migrator().$executeRaw`
      UPDATE export_job SET status = 'EXPIRED', purge_file_after = now() - interval '1 second'
       WHERE id = ${id}::uuid`;
    const due = (await exportFilesDue(500)).filter((d) => d.exportJobId === id);
    // The real worker sweeps on its own schedule; if it got there first, the outcome is the same.
    if (due.length)
      expect(await sweepExportFiles(due, storage, markExportFileDeleted)).toEqual({
        deleted: 1,
        refused: 0,
        errors: 0,
      });
    expect(await storage.stat(j.storageKey)).toBeNull();
    expect(
      (await migrator().exportJob.findUniqueOrThrow({ where: { id } })).fileDeletedAt,
    ).not.toBeNull();
  });
});

describe('suspended users', () => {
  it('a suspended Admin can no longer act', async () => {
    const id = await created(A.users.exec1, A);
    await migrator().member.update({
      where: { id: A.membership.admin! },
      data: { status: 'SUSPENDED' },
    });
    try {
      const r = await br.admin.action(`/app/leads/${id}`, L, 'archiveLeadAction', {
        leadId: id,
        version: await version(id),
      });
      expect(r.ok).not.toBe(true);
      expect((await migrator().lead.findUniqueOrThrow({ where: { id } })).archivedAt).toBeNull();
    } finally {
      await migrator().member.update({
        where: { id: A.membership.admin! },
        data: { status: 'ACTIVE' },
      });
    }
  });
});

describe('private download responses (M5 §I.4 F1)', () => {
  // Fresh orgs: export_job_quota (5 per requester per 24 h) counts these fixture rows too, and
  // A's Owner has already used most of the quota above.
  const NO_STORE = 'private, no-store';
  type Who = Record<'owner' | 'admin' | 'exec1', Browser> & { org: Org };
  const orgWith = async (name: string): Promise<Who> => {
    const org = await seedOrg(name);
    return {
      org,
      owner: await browserFor(org.users.owner, org.orgId),
      admin: await browserFor(org.users.admin, org.orgId),
      exec1: await browserFor(org.users.exec1, org.orgId),
    };
  };
  const fixture = async (org: Org, state: 'ready' | 'expired', withObject: boolean) => {
    const id = randomUUID();
    const key = `orgs/${org.orgId}/exports/${id}/${randomBytes(16).toString('hex')}.csv`;
    const body = Buffer.from('Lead ID,Name\r\n');
    if (withObject) await storage.put(key, body, 'text/csv');
    const sha = withObject ? createHash('sha256').update(body).digest() : randomBytes(32);
    if (state === 'ready')
      await migrator().$executeRaw`
        INSERT INTO export_job (id, org_id, requested_by, storage_key, status, created_at,
          started_at, finished_at, expires_at, row_count, sha256, purge_file_after)
        VALUES (${id}::uuid, ${org.orgId}::uuid, ${org.users.owner.id}::uuid, ${key}, 'READY',
          now() - interval '2 minutes', now() - interval '2 minutes', now() - interval '1 minute',
          now() + interval '14 minutes', 1, ${sha}, now() + interval '50 minutes')`;
    else
      await migrator().$executeRaw`
        INSERT INTO export_job (id, org_id, requested_by, storage_key, status, created_at,
          started_at, finished_at, expires_at, row_count, sha256, purge_file_after)
        VALUES (${id}::uuid, ${org.orgId}::uuid, ${org.users.owner.id}::uuid, ${key}, 'READY',
          now() - interval '25 minutes', now() - interval '21 minutes',
          now() - interval '20 minutes', now() - interval '5 minutes', 1, ${sha},
          now() + interval '30 minutes')`;
    return id;
  };
  const url = (id: string) => `/app/leads/exports/${id}/download`;
  const expectPrivate = (res: Response, status: number) => {
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe(NO_STORE);
  };

  it('every status of the download route carries private, no-store over real HTTP', async () => {
    const c = await orgWith('E2EM5C');
    const ok = await fixture(c.org, 'ready', true);
    expectPrivate(await c.owner.get(url(ok)), 200); // success
    expectPrivate(await c.owner.get(url(ok)), 410); // already used
    expectPrivate(await c.owner.get(url(await fixture(c.org, 'expired', true))), 410); // expired
    expectPrivate(await c.owner.get(url(await fixture(c.org, 'ready', false))), 503); // storage
    expectPrivate(await c.owner.get(url(randomUUID())), 404); // missing
    expectPrivate(await c.owner.get('/app/leads/exports/not-a-uuid/download'), 404); // malformed
    const other = await fixture(c.org, 'ready', true);
    expectPrivate(await c.admin.get(url(other)), 404); // role without lead.export
    expectPrivate(await c.exec1.get(url(other)), 404);
    expectPrivate(await br.ownerB.get(url(other)), 404); // another org: no existence leak
    // Signed out: the proxy redirects before the route runs; the redirect is private too.
    const anon = await new Browser().get(url(other));
    expectPrivate(anon, 307);
    expect(anon.headers.get('location')).toMatch(/\/login\?next=/);
    // A session cookie that resolves to nobody reaches the route and gets a private 401.
    const forged = await fetch(`${BASE}${url(other)}`, {
      headers: { cookie: 'cbr.session_token=forged.value' },
      redirect: 'manual',
    });
    expectPrivate(forged, 401);
    // Framework-generated responses (another method) are covered by the config headers.
    const post = await c.owner.fetch(url(other), { method: 'POST' });
    expect(post.headers.get('cache-control')).toBe(NO_STORE);
    // Refusals consumed nothing: the Owner can still download it once.
    expectPrivate(await c.owner.get(url(other)), 200);
  });

  it('shared browser: after the Owner used an export, the next user gets their own uncached answer', async () => {
    const d = await orgWith('E2EM5D');
    const id = await fixture(d.org, 'ready', true);
    expectPrivate(await d.owner.get(url(id)), 200);
    expectPrivate(await d.owner.get(url(id)), 410);
    // The same URL from the Admin (same org, no export permission) and from another org's
    // Owner: the server answers each with its own refusal (404), never the Owner's 410, and
    // nothing in the response can be cached for the next person.
    for (const who of [d.admin, br.ownerB]) {
      const res = await who.get(url(id));
      expectPrivate(res, 404);
      expect(await res.text()).toBe('Not found');
    }
  });

  it('the import problems CSV route is private on refusal too', async () => {
    expectPrivate(await br.owner.get(`/app/leads/import/${randomUUID()}/issues.csv`), 404);
    const anon = await new Browser().get(`/app/leads/import/${randomUUID()}/issues.csv`);
    expectPrivate(anon, 307);
  });
});
