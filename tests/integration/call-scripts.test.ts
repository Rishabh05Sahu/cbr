// Phase 3 slice 5 (migration 0014): call script authoring and publishing. FR-095 (sections,
// sanitized rich text), FR-096 (targeting, deterministic match order), FR-097 (draft →
// published → archived; published versions immutable; editing a published script creates a new
// draft version). Role matrix §4.2 in the app and in the database, other orgs, concurrency.
// FR-057/FR-099: what the lead-page script panel may show (suggestForLead).
// Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as scripts from '@/modules/scripts';
import { DomainError } from '@/platform/errors';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';
let A: Org;
let B: Org;
const a = {} as Record<Role, Actor>;
let ownerB: Actor;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof Error && e.name === 'ZodError') return 'VALIDATION_FAILED';
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
/** One statement as crm_app for a member, the way withTenant() connects. */
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

const draft = (over: Partial<Record<string, unknown>> = {}) => ({
  opening: 'Namaste, this is **Synthetic** Realty.',
  questions: '- Budget?\n- Area?',
  pitch: '1. Ready to move\n2. Near metro',
  closing: 'Shall I book a _site visit_?',
  objections: [{ objection: 'Too expensive', response: 'We have options from **50 L**.' }],
  draftVersion: 0,
  ...over,
});
const scriptRow = (id: string) => migrator().callScript.findUniqueOrThrow({ where: { id } });
const versionsOf = (scriptId: string) =>
  migrator().callScriptVersion.findMany({ where: { scriptId }, orderBy: { versionNo: 'asc' } });

let seq = 0;
async function newScript(by: Actor = a.admin, name?: string): Promise<string> {
  return (await scripts.createScript(by.ctx, { name: name ?? `Synthetic script ${++seq}` })).id;
}
/** A script with a published version 1. */
async function published(name?: string): Promise<string> {
  const id = await newScript(a.admin, name);
  await scripts.saveDraft(a.admin.ctx, id, draft({ draftVersion: 1 }));
  await scripts.publishScript(a.admin.ctx, id, { draftVersion: 2 });
  return id;
}

beforeAll(async () => {
  A = await seedOrg('ScriptA');
  B = await seedOrg('ScriptB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('authoring and versions (FR-095, FR-097)', () => {
  it('creates a draft, saves sanitized sections, publishes an immutable version', async () => {
    const id = await newScript(a.admin, '  Buyers   first call ');
    expect(await scriptRow(id)).toMatchObject({
      name: 'Buyers first call',
      status: 'DRAFT',
      currentVersionId: null,
      createdBy: A.users.admin.id,
    });
    await scripts.saveDraft(a.admin.ctx, id, draft({ draftVersion: 1 }));
    const [v1] = await versionsOf(id);
    const content = scripts.readContent(v1!.content);
    expect(content.opening).toEqual({
      text: 'Namaste, this is **Synthetic** Realty.',
      html: '<p>Namaste, this is <strong>Synthetic</strong> Realty.</p>',
    });
    expect(content.questions.html).toBe('<ul><li>Budget?</li><li>Area?</li></ul>');
    expect(content.objections[0]).toMatchObject({ objection: 'Too expensive' });

    expect(await scripts.publishScript(a.admin.ctx, id, { draftVersion: 2 })).toEqual({
      versionNo: 1,
    });
    const s = await scriptRow(id);
    const [pub] = await versionsOf(id);
    expect(s).toMatchObject({ status: 'PUBLISHED', currentVersionId: pub!.id });
    expect(pub).toMatchObject({ publishedBy: A.users.admin.id });
    expect(pub!.publishedAt).not.toBeNull();
    expect(
      (
        await migrator().auditLog.findMany({
          where: { entityId: id },
          orderBy: { occurredAt: 'asc' },
        })
      ).map((e) => e.action),
    ).toEqual(['script.created', 'script.draft_saved', 'script.published']);
  });

  it('editing a published script creates the next draft; the live version never changes', async () => {
    const id = await published();
    const [v1Before] = await versionsOf(id);
    expect(await scripts.saveDraft(a.admin.ctx, id, draft({ opening: 'Changed opening' }))).toEqual(
      { versionNo: 2 },
    );
    const [v1, v2] = await versionsOf(id);
    expect(v1).toEqual(v1Before);
    expect(v2).toMatchObject({ versionNo: 2, publishedAt: null });
    expect((await scriptRow(id)).currentVersionId).toBe(v1!.id);
    // The reader still sees version 1 until version 2 is published.
    expect((await scripts.getPublishedScript(a.exec1.ctx, id)).versionNo).toBe(1);
    await scripts.publishScript(a.admin.ctx, id, { draftVersion: 1 });
    const live = await scripts.getPublishedScript(a.exec1.ctx, id);
    expect(live).toMatchObject({ versionNo: 2 });
    expect(live.content.opening.html).toBe('<p>Changed opening</p>');
    expect((await versionsOf(id))[0]).toEqual(v1Before);
  });

  it('stores author HTML as escaped text, never as markup', async () => {
    const id = await newScript();
    await scripts.saveDraft(
      a.admin.ctx,
      id,
      draft({
        draftVersion: 1,
        opening: '<script>alert(1)</script><img src=x onerror=alert(1)> **ok**',
        objections: [{ objection: '<b>x</b>', response: '<svg onload=alert(1)>' }],
      }),
    );
    const c = scripts.readContent((await versionsOf(id))[0]!.content);
    expect(c.opening.html).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt; <strong>ok</strong></p>',
    );
    expect(c.objections[0]!.response.html).toBe('<p>&lt;svg onload=alert(1)&gt;</p>');
    expect(c.objections[0]!.objection).toBe('<b>x</b>'); // plain text, escaped by React
  });

  it('validates input and refuses to publish an empty draft', async () => {
    const id = await newScript();
    expect(
      await codeOf(
        scripts.saveDraft(a.admin.ctx, id, draft({ draftVersion: 1, opening: 'x'.repeat(5001) })),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(await codeOf(scripts.publishScript(a.admin.ctx, id, { draftVersion: 1 }))).toBe(
      'RULE_VIOLATION',
    );
    expect(await codeOf(scripts.createScript(a.admin.ctx, { name: '   ' }))).toBe(
      'VALIDATION_FAILED',
    );
    // Languages are two-letter codes, like the lead's language (app and database).
    expect(
      await codeOf(
        scripts.updateScriptSettings(a.admin.ctx, id, {
          name: 'Language check',
          transactionTypes: [],
          propertyTypes: [],
          languages: 'Marathi',
          sourceIds: [],
          version: 1,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await sqlState(
        asApp(
          A,
          A.users.admin.id,
          `UPDATE call_script SET languages = ARRAY['Marathi'], version = version + 1 WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe('23514');
    await newScript(a.admin, 'Unique Name');
    expect(await codeOf(scripts.createScript(a.admin.ctx, { name: ' unique   NAME ' }))).toBe(
      'CONFLICT',
    );
  });

  it('archives a script, keeping it and its versions; nothing can change afterwards', async () => {
    const id = await published();
    await scripts.saveDraft(a.admin.ctx, id, draft({ opening: 'Pending change' }));
    const before = await versionsOf(id);
    await scripts.archiveScript(a.admin.ctx, id, { version: (await scriptRow(id)).version });
    expect(await scriptRow(id)).toMatchObject({ status: 'ARCHIVED' });
    expect((await scriptRow(id)).archivedAt).not.toBeNull();
    expect(await versionsOf(id)).toEqual(before);
    for (const run of [
      () => scripts.saveDraft(a.admin.ctx, id, draft({ draftVersion: 1 })),
      () => scripts.publishScript(a.admin.ctx, id, { draftVersion: 1 }),
      () => scripts.archiveScript(a.admin.ctx, id, { version: 99 }),
    ])
      expect(await codeOf(run())).toBe('RULE_VIOLATION');
    expect(await codeOf(scripts.getPublishedScript(a.exec1.ctx, id))).toBe('NOT_FOUND');
    expect(
      (await scripts.listScriptsForManage(a.admin.ctx)).find((s) => s.id === id),
    ).toMatchObject({ status: 'ARCHIVED' });
  });
});

describe('concurrency', () => {
  it('two editors saving the same draft: one wins, the other is refused', async () => {
    const id = await newScript();
    const results = await Promise.allSettled([
      scripts.saveDraft(a.admin.ctx, id, draft({ draftVersion: 1, opening: 'One' })),
      scripts.saveDraft(a.owner.ctx, id, draft({ draftVersion: 1, opening: 'Two' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as DomainError).code).toBe('CONFLICT');
    expect((await versionsOf(id))[0]!.version).toBe(2);
  });

  it('two editors starting a new draft of a published script create exactly one', async () => {
    const id = await published();
    const results = await Promise.allSettled([
      scripts.saveDraft(a.admin.ctx, id, draft({ opening: 'A' })),
      scripts.saveDraft(a.owner.ctx, id, draft({ opening: 'B' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await versionsOf(id)).map((v) => v.versionNo)).toEqual([1, 2]);
  });

  it('publishing twice at once publishes one version once', async () => {
    const id = await newScript();
    await scripts.saveDraft(a.admin.ctx, id, draft({ draftVersion: 1 }));
    const results = await Promise.allSettled([
      scripts.publishScript(a.admin.ctx, id, { draftVersion: 2 }),
      scripts.publishScript(a.owner.ctx, id, { draftVersion: 2 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const vs = await versionsOf(id);
    expect(vs).toHaveLength(1);
    expect(vs[0]!.publishedAt).not.toBeNull();
    expect(
      await migrator().auditLog.count({ where: { entityId: id, action: 'script.published' } }),
    ).toBe(1);
  });

  it('a stale editor cannot overwrite a newer draft or publish an old one', async () => {
    const id = await published();
    await scripts.saveDraft(a.admin.ctx, id, draft({ opening: 'v2 first' })); // draft v2, version 1
    expect(
      await codeOf(scripts.saveDraft(a.owner.ctx, id, draft({ draftVersion: 0, opening: 'x' }))),
    ).toBe('CONFLICT');
    await scripts.saveDraft(a.admin.ctx, id, draft({ draftVersion: 1, opening: 'v2 second' }));
    expect(await codeOf(scripts.publishScript(a.owner.ctx, id, { draftVersion: 1 }))).toBe(
      'CONFLICT',
    );
  });
});

describe('permissions (§4.2) and isolation', () => {
  it('only Owner/Admin author; managers and executives read published; HR nothing', async () => {
    const pub = await published();
    const draftOnly = await newScript();
    for (const who of [a.manager, a.exec1, a.hr])
      expect(await codeOf(scripts.createScript(who.ctx, { name: 'Not allowed' }))).toBe(
        'FORBIDDEN',
      );
    for (const run of [
      () => scripts.saveDraft(a.manager.ctx, pub, draft()),
      () => scripts.publishScript(a.manager.ctx, pub, { draftVersion: 1 }),
      () => scripts.archiveScript(a.manager.ctx, pub, { version: 1 }),
      () => scripts.listScriptsForManage(a.manager.ctx),
    ])
      expect(await codeOf(run())).toBe('FORBIDDEN');
    for (const who of [a.manager, a.exec1]) {
      const ids = (await scripts.listPublishedScripts(who.ctx)).map((s) => s.id);
      expect(ids).toContain(pub);
      expect(ids).not.toContain(draftOnly);
      expect(await codeOf(scripts.getPublishedScript(who.ctx, draftOnly))).toBe('NOT_FOUND');
    }
    expect(await codeOf(scripts.listPublishedScripts(a.hr.ctx))).toBe('FORBIDDEN');
  });

  it('enforces the same matrix in the database for crm_app', async () => {
    const pub = await published();
    await scripts.saveDraft(a.admin.ctx, pub, draft({ opening: 'unpublished' }));
    const draftOnly = await newScript();
    const sel = 'SELECT id FROM call_script WHERE id = ANY($1::uuid[])';
    const selV = 'SELECT version_no FROM call_script_version WHERE script_id = $1 ORDER BY 1';
    expect((await asApp(A, A.users.exec1.id, sel, [[pub, draftOnly]])).rows).toEqual([{ id: pub }]);
    expect((await asApp(A, A.users.exec1.id, selV, [pub])).rows).toEqual([{ version_no: 1 }]);
    expect((await asApp(A, A.users.admin.id, selV, [pub])).rows).toEqual([
      { version_no: 1 },
      { version_no: 2 },
    ]);
    expect((await asApp(A, A.users.hr.id, sel, [[pub, draftOnly]])).rowCount).toBe(0);
    expect((await asApp(B, B.users.owner.id, sel, [[pub, draftOnly]])).rowCount).toBe(0);
    // Writes by a sales manager are refused by the role policies.
    expect(
      await sqlState(
        asApp(
          A,
          A.users.manager.id,
          `INSERT INTO call_script (org_id, name, created_by) VALUES ($1, 'x', $2)`,
          [A.orgId, A.users.manager.id],
        ),
      ),
    ).toBe('42501');
    const upd = await asApp(
      A,
      A.users.manager.id,
      `UPDATE call_script SET name = 'hijack', version = version + 1 WHERE id = $1`,
      [pub],
    );
    expect(upd.rowCount).toBe(0);
    expect((await scriptRow(pub)).name).not.toBe('hijack');
  });

  it('makes published versions immutable in the database, even for Owner/Admin', async () => {
    const id = await published();
    const [v1] = await versionsOf(id);
    const owner = A.users.owner.id;
    expect(
      await sqlState(
        asApp(
          A,
          owner,
          `UPDATE call_script_version SET content = '{}'::jsonb, version = version + 1 WHERE id = $1`,
          [v1!.id],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(asApp(A, owner, 'DELETE FROM call_script_version WHERE id = $1', [v1!.id])),
    ).toBe('42501');
    expect(await sqlState(asApp(A, owner, 'DELETE FROM call_script WHERE id = $1', [id]))).toBe(
      '42501',
    );
    // A draft cannot be published with different content in the same statement, and the live
    // version must be one of the script's published versions.
    await scripts.saveDraft(a.admin.ctx, id, draft({ opening: 'next' }));
    const [, v2] = await versionsOf(id);
    expect(
      await sqlState(
        asApp(
          A,
          owner,
          `UPDATE call_script_version SET published_at = now(), published_by = $2,
             content = '{}'::jsonb, version = version + 1 WHERE id = $1`,
          [v2!.id, owner],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        asApp(
          A,
          owner,
          `UPDATE call_script SET current_version_id = $2, version = version + 1 WHERE id = $1`,
          [id, v2!.id],
        ),
      ),
    ).toBe('23514');
    expect(await versionsOf(id).then((vs) => vs[0])).toEqual(v1);
  });

  it('keeps another organisation out entirely', async () => {
    const id = await published();
    for (const run of [
      () => scripts.getPublishedScript(ownerB.ctx, id),
      () => scripts.getScriptForEditing(ownerB.ctx, id),
      () => scripts.saveDraft(ownerB.ctx, id, draft()),
      () => scripts.publishScript(ownerB.ctx, id, { draftVersion: 1 }),
      () => scripts.archiveScript(ownerB.ctx, id, { version: 1 }),
    ])
      expect(await codeOf(run())).toBe('NOT_FOUND');
    const bSource = (await leads.listLeadSources(ownerB.ctx))[0];
    if (bSource) {
      const mine = await newScript();
      expect(
        await codeOf(
          scripts.updateScriptSettings(a.admin.ctx, mine, {
            name: 'With B source',
            transactionTypes: [],
            propertyTypes: [],
            languages: '',
            sourceIds: [bSource.id],
            version: 1,
          }),
        ),
      ).toBe('VALIDATION_FAILED');
    }
  });
});

describe('targeting and suggestions (FR-096)', () => {
  it('ranks published scripts for a lead in the documented order', async () => {
    const lead = await leads.createLead(a.exec1.ctx, {
      fullName: 'Synthetic Matching',
      primaryPhone: '9876501234',
      transactionType: 'BUY',
      propertyType: 'APARTMENT',
    });
    if (lead.status !== 'created') throw new Error('fixture lead');
    await migrator().lead.update({
      where: { id: lead.leadId },
      data: { preferredLanguage: 'mr' },
    });
    const target = async (id: string, t: Record<string, unknown>) =>
      scripts.updateScriptSettings(a.admin.ctx, id, {
        name: (await scriptRow(id)).name,
        transactionTypes: [],
        propertyTypes: [],
        languages: '',
        sourceIds: [],
        version: (await scriptRow(id)).version,
        ...t,
      });
    const generic = await published('Zz Generic');
    const buyers = await published('Buyers');
    const aptBuyers = await published('Apartment buyers');
    const renters = await published('Renters');
    const marathi = await published('Marathi apartments');
    await target(buyers, { transactionTypes: ['BUY'] });
    await target(aptBuyers, { transactionTypes: ['BUY'], propertyTypes: ['APARTMENT'] });
    await target(renters, { transactionTypes: ['RENT'] });
    await target(marathi, { propertyTypes: ['APARTMENT'], languages: 'MR' });
    const archivedMatch = await published('Archived buyers');
    await target(archivedMatch, { transactionTypes: ['BUY'] });
    await scripts.archiveScript(a.admin.ctx, archivedMatch, {
      version: (await scriptRow(archivedMatch)).version,
    });

    const ranked = (await scripts.suggestForLead(a.exec1.ctx, lead.leadId))
      .filter((s) => [generic, buyers, aptBuyers, renters, marathi, archivedMatch].includes(s.id))
      .map((s) => [s.name, s.score]);
    expect(ranked).toEqual([
      ['Apartment buyers', 2],
      ['Marathi apartments', 2],
      ['Buyers', 1],
      ['Zz Generic', 0],
    ]);
    expect(await codeOf(scripts.suggestForLead(a.hr.ctx, lead.leadId))).toBe('FORBIDDEN');
  });
});

describe('lead-page script panel (FR-057/FR-099)', () => {
  /** A lead of exec1's, with the given requirement values (synthetic). */
  async function leadFor(phone: string, language?: string) {
    const lead = await leads.createLead(a.exec1.ctx, {
      fullName: 'Synthetic Panel',
      primaryPhone: phone,
      transactionType: 'RENT',
      propertyType: 'VILLA',
    });
    if (lead.status !== 'created') throw new Error('fixture lead');
    if (language)
      await migrator().lead.update({
        where: { id: lead.leadId },
        data: { preferredLanguage: language },
      });
    return lead.leadId;
  }
  async function targeted(name: string, t: Record<string, unknown>, publish = true) {
    const id = publish ? await published(name) : await newScript(a.admin, name);
    await scripts.updateScriptSettings(a.admin.ctx, id, {
      name,
      transactionTypes: [],
      propertyTypes: [],
      languages: '',
      sourceIds: [],
      version: (await scriptRow(id)).version,
      ...t,
    });
    return id;
  }
  const names = async (actor: Actor, leadId: string, only: string[]) =>
    (await scripts.suggestForLead(actor.ctx, leadId))
      .filter((s) => only.includes(s.id))
      .map((s) => s.name);

  it('shows only published live versions: never drafts, archived scripts or unpublished edits', async () => {
    const leadId = await leadFor('9876502001');
    const live = await targeted('Panel villa renters', { propertyTypes: ['VILLA'] });
    const draftOnly = await targeted('Panel draft villas', { propertyTypes: ['VILLA'] }, false);
    await scripts.saveDraft(a.admin.ctx, draftOnly, draft({ draftVersion: 1 }));
    const archived = await targeted('Panel archived villas', { propertyTypes: ['VILLA'] });
    await scripts.archiveScript(a.admin.ctx, archived, {
      version: (await scriptRow(archived)).version,
    });
    // An edit of the live script stays a draft: the panel keeps showing version 1.
    await scripts.saveDraft(a.admin.ctx, live, draft({ opening: 'Unpublished opening' }));

    const shown = await scripts.suggestForLead(a.exec1.ctx, leadId);
    const ids = shown.map((s) => s.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(draftOnly);
    expect(ids).not.toContain(archived);
    const liveShown = shown.find((s) => s.id === live)!;
    expect(liveShown.versionNo).toBe(1);
    expect(liveShown.content.opening.text).toBe('Namaste, this is **Synthetic** Realty.');
  });

  it('matches language codes and refuses a mismatch or a lead without a language', async () => {
    const hindi = await targeted('Panel Hindi villas', {
      propertyTypes: ['VILLA'],
      languages: 'hi',
    });
    const any = await targeted('Panel any villas', { propertyTypes: ['VILLA'] });
    const only = [hindi, any];
    expect(await names(a.exec1, await leadFor('9876502002', 'hi'), only)).toEqual([
      'Panel Hindi villas',
      'Panel any villas',
    ]);
    expect(await names(a.exec1, await leadFor('9876502003', 'mr'), only)).toEqual([
      'Panel any villas',
    ]);
    expect(await names(a.exec1, await leadFor('9876502004'), only)).toEqual(['Panel any villas']);
    // No match at all: an empty list, not an error.
    const plot = await targeted('Panel plots only', { propertyTypes: ['PLOT'] });
    expect(await names(a.exec1, await leadFor('9876502005'), [plot])).toEqual([]);
  });

  it('follows lead scope and the role matrix; another organisation sees nothing', async () => {
    const leadId = await leadFor('9876502006');
    const s = await targeted('Panel scope villas', { propertyTypes: ['VILLA'] });
    for (const who of [a.owner, a.admin, a.exec1])
      expect((await scripts.suggestForLead(who.ctx, leadId)).map((x) => x.id)).toContain(s);
    // Out of scope looks like a missing lead: another executive's lead, and a lead outside the
    // manager's team (the fixture org has no teams, so the manager's team scope is empty).
    expect(await codeOf(scripts.suggestForLead(a.exec2.ctx, leadId))).toBe('NOT_FOUND');
    expect(await codeOf(scripts.suggestForLead(a.manager.ctx, leadId))).toBe('NOT_FOUND');
    expect(await codeOf(scripts.suggestForLead(a.hr.ctx, leadId))).toBe('FORBIDDEN');
    // Org B: A's lead does not exist for them, and A's scripts never reach B's leads.
    expect(await codeOf(scripts.suggestForLead(ownerB.ctx, leadId))).toBe('NOT_FOUND');
    const leadB = await leads.createLead(ownerB.ctx, {
      fullName: 'Synthetic Panel B',
      primaryPhone: '9876502007',
      transactionType: 'RENT',
      propertyType: 'VILLA',
    });
    if (leadB.status !== 'created') throw new Error('fixture lead');
    const forB = await scripts.suggestForLead(ownerB.ctx, leadB.leadId);
    expect(forB.map((x) => x.id)).not.toContain(s);
    const rows = await migrator().callScript.findMany({
      where: { id: { in: forB.map((x) => x.id) } },
    });
    expect(rows.every((r) => r.orgId === B.orgId)).toBe(true);
  });

  it('still shows scripts on do-not-contact and invalid leads without changing contact status', async () => {
    const s = await targeted('Panel restricted villas', { propertyTypes: ['VILLA'] });
    for (const toStatus of ['DO_NOT_CONTACT', 'INVALID'] as const) {
      const leadId = await leadFor(toStatus === 'INVALID' ? '9876502008' : '9876502009');
      await leads.changeContactStatus(a.exec1.ctx, leadId, {
        toStatus,
        version: (await migrator().lead.findUniqueOrThrow({ where: { id: leadId } })).version,
        reason: 'Synthetic restriction',
        ...(toStatus === 'DO_NOT_CONTACT' ? { method: 'WRITTEN' } : {}),
      });
      const before = await migrator().lead.findUniqueOrThrow({ where: { id: leadId } });
      const events = () => migrator().leadContactStatusEvent.count({ where: { leadId } });
      const eventsBefore = await events();
      expect((await scripts.suggestForLead(a.exec1.ctx, leadId)).map((x) => x.id)).toContain(s);
      const after = await migrator().lead.findUniqueOrThrow({ where: { id: leadId } });
      expect(after).toMatchObject({ contactStatus: toStatus, version: before.version });
      expect(await events()).toBe(eventsBefore);
    }
  });
});
