// Phase 3 slice 6 (migration 0015): FR-065 contact status / Do-Not-Contact. Transitions, who may
// make them (app and database), the append-only evidence (event, timeline, audit), carry-over to
// a new lead for the same number, merge, archive, stage changes, other orgs, concurrency and the
// shared outbound check. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import { tenantRunner } from '@/platform/db';
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
async function fieldsOf(p: Promise<unknown>): Promise<string[]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return Object.keys(e.fieldErrors ?? {}).sort();
    throw e;
  }
  return [];
}
async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERR';
  }
}
/** Statements as crm_app for a member, in one transaction, the way withTenant() connects. */
async function asApp(org: Org, userId: string, ...stmts: [string, unknown[]?][]) {
  return withRole(APP, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [org.orgId, userId],
      );
      let r;
      for (const [sql, params] of stmts) r = await c.query(sql, params ?? []);
      await c.query('COMMIT');
      return r!;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

let seq = 0;
const phone = () => `97${String(30_000_000 + ++seq * 7_919).slice(-8)}`;
async function created(by: Actor, input: Record<string, string> = {}) {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Contact',
    primaryPhone: phone(),
    ...input,
  });
  if (r.status !== 'created') throw new Error('expected a new lead');
  return r.leadId;
}
const row = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const events = (leadId: string) =>
  migrator().leadContactStatusEvent.findMany({ where: { leadId }, orderBy: { changedAt: 'asc' } });
async function setStatus(by: Actor, id: string, body: Record<string, unknown>) {
  return leads.changeContactStatus(by.ctx, id, { version: (await row(id)).version, ...body });
}
const dnc = (by: Actor, id: string) =>
  setStatus(by, id, { toStatus: 'DO_NOT_CONTACT', method: 'VERBAL', reason: 'Asked on a call' });
const lift = (by: Actor, id: string, over: Record<string, unknown> = {}) =>
  setStatus(by, id, {
    toStatus: 'OK',
    method: 'FORM_OPT_IN',
    evidenceRef: 'Synthetic form 1',
    reason: 'Opted in again',
    ...over,
  });

beforeAll(async () => {
  A = await seedOrg('ContactA');
  B = await seedOrg('ContactB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('transitions (app)', () => {
  it('a Sales Executive records do-not-contact on their own lead, with evidence kept', async () => {
    const id = await created(a.exec1);
    const v = (await row(id)).version;
    await leads.changeContactStatus(a.exec1.ctx, id, {
      toStatus: 'DO_NOT_CONTACT',
      version: v,
      method: 'WRITTEN',
      reason: 'WhatsApp message: please stop calling',
      evidenceRef: 'Message 28 Oct 10:02',
    });
    expect(await row(id)).toMatchObject({ contactStatus: 'DO_NOT_CONTACT', version: v + 1 });
    const [e] = await events(id);
    expect(e).toMatchObject({
      fromStatus: 'OK',
      toStatus: 'DO_NOT_CONTACT',
      origin: 'MANUAL',
      method: 'WRITTEN',
      reason: 'WhatsApp message: please stop calling',
      evidenceRef: 'Message 28 Oct 10:02',
      changedBy: A.users.exec1.id,
    });
    // Timeline and audit name the change, never the reason or evidence text.
    const act = await migrator().leadActivity.findFirstOrThrow({
      where: { leadId: id, type: 'CONTACT_STATUS' },
    });
    expect(act).toMatchObject({ actorId: A.users.exec1.id, refId: e!.id });
    expect(act.summary).toEqual({
      from: 'OK',
      to: 'DO_NOT_CONTACT',
      origin: 'MANUAL',
      method: 'WRITTEN',
    });
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { action: 'lead.contact_status_changed', entityId: id },
    });
    expect(audit).toMatchObject({ actorUserId: A.users.exec1.id, actorKind: 'USER' });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/WhatsApp|Message 28/);
    // History is readable in scope.
    const h = await leads.contactStatusHistory(a.exec1.ctx, id);
    expect(h[0]).toMatchObject({ toStatus: 'DO_NOT_CONTACT', changedByName: expect.any(String) });
  });

  it('marks a number invalid and valid again (reason required, no method)', async () => {
    const id = await created(a.exec1);
    expect(await fieldsOf(setStatus(a.exec1, id, { toStatus: 'INVALID' }))).toEqual(['reason']);
    await setStatus(a.exec1, id, { toStatus: 'INVALID', reason: 'Number not in service' });
    expect((await row(id)).contactStatus).toBe('INVALID');
    await setStatus(a.exec1, id, { toStatus: 'OK', reason: 'Number corrected by customer' });
    expect((await row(id)).contactStatus).toBe('OK');
    expect((await events(id)).map((e) => [e.fromStatus, e.toStatus, e.method])).toEqual([
      ['OK', 'INVALID', null],
      ['INVALID', 'OK', null],
    ]);
  });

  it('needs how do-not-contact was asked for, and refuses no-op changes', async () => {
    const id = await created(a.exec1);
    expect(
      await fieldsOf(setStatus(a.exec1, id, { toStatus: 'DO_NOT_CONTACT', reason: 'Asked' })),
    ).toEqual(['method']);
    expect(await fieldsOf(setStatus(a.exec1, id, { toStatus: 'OK', reason: 'x' }))).toEqual([
      'toStatus',
    ]);
    await setStatus(a.exec1, id, { toStatus: 'INVALID', reason: 'Wrong number' });
    await dnc(a.exec1, id); // INVALID -> DO_NOT_CONTACT is allowed
    expect((await row(id)).contactStatus).toBe('DO_NOT_CONTACT');
  });

  it('only Owner/Admin lift do-not-contact, with a consent basis and evidence', async () => {
    const id = await created(a.exec1);
    await dnc(a.exec1, id);
    expect(await fieldsOf(lift(a.exec1, id))).toEqual(['toStatus']);
    expect(await fieldsOf(lift(a.admin, id, { evidenceRef: '' }))).toEqual(['evidenceRef']);
    expect(await fieldsOf(lift(a.admin, id, { method: 'OTHER' }))).toEqual(['method']);
    expect(await fieldsOf(lift(a.owner, id, { toStatus: 'INVALID' }))).toContain('toStatus');
    await lift(a.admin, id);
    expect((await row(id)).contactStatus).toBe('OK');
    expect((await events(id)).at(-1)).toMatchObject({
      fromStatus: 'DO_NOT_CONTACT',
      toStatus: 'OK',
      method: 'FORM_OPT_IN',
      evidenceRef: 'Synthetic form 1',
      changedBy: A.users.admin.id,
    });
  });

  it('refuses a stale form and another org, and keeps scope', async () => {
    const id = await created(a.exec1);
    expect(
      await codeOf(
        leads.changeContactStatus(a.exec1.ctx, id, {
          toStatus: 'INVALID',
          version: (await row(id)).version - 1 || 99,
          reason: 'x',
        }),
      ),
    ).toBe('CONFLICT');
    expect(await codeOf(dnc(a.exec2, id))).toBe('NOT_FOUND'); // not their lead
    expect(await codeOf(dnc(ownerB, id))).toBe('NOT_FOUND'); // other org
    expect(await codeOf(dnc(a.hr, id))).toBe('FORBIDDEN');
    expect(await codeOf(leads.contactStatusHistory(a.hr.ctx, id))).toBe('FORBIDDEN');
    expect((await row(id)).contactStatus).toBe('OK');
  });

  it('serialises two concurrent changes: one wins, the other is told to reload', async () => {
    const id = await created(a.exec1);
    const v = (await row(id)).version;
    const results = await Promise.all([
      codeOf(
        leads.changeContactStatus(a.exec1.ctx, id, {
          toStatus: 'DO_NOT_CONTACT',
          version: v,
          method: 'VERBAL',
          reason: 'Asked',
        }),
      ),
      codeOf(
        leads.changeContactStatus(a.admin.ctx, id, {
          toStatus: 'INVALID',
          version: v,
          reason: 'Wrong',
        }),
      ),
    ]);
    expect(results.sort()).toEqual(['CONFLICT', 'OK']);
    expect(await events(id)).toHaveLength(1);
  });
});

describe('lead lifecycle', () => {
  it('an archived lead accepts do-not-contact only; stage changes leave the status alone', async () => {
    const id = await created(a.admin);
    await leads.archiveLead(a.admin.ctx, id, { version: (await row(id)).version });
    expect(
      await fieldsOf(setStatus(a.admin, id, { toStatus: 'INVALID', reason: 'Wrong' })),
    ).toEqual(['toStatus']);
    await dnc(a.admin, id);
    expect(await row(id)).toMatchObject({ contactStatus: 'DO_NOT_CONTACT' });

    const won = await created(a.exec1);
    await dnc(a.exec1, won);
    await leads.changeStage(a.exec1.ctx, won, {
      toStage: 'LOST',
      version: (await row(won)).version,
      reasonCode: 'OTHER',
    });
    expect(await row(won)).toMatchObject({ stage: 'LOST', contactStatus: 'DO_NOT_CONTACT' });
  });

  it('a new lead for the number of a closed do-not-contact lead starts do-not-contact', async () => {
    const p = phone();
    const old = await created(a.exec1, { primaryPhone: p });
    await dnc(a.exec1, old);
    await leads.changeStage(a.exec1.ctx, old, {
      toStage: 'LOST',
      version: (await row(old)).version,
      reasonCode: 'OTHER',
    });
    const again = await created(a.exec2, { primaryPhone: p });
    expect(await row(again)).toMatchObject({
      previousLeadId: old,
      contactStatus: 'DO_NOT_CONTACT',
    });
    expect(await events(again)).toEqual([
      expect.objectContaining({
        fromStatus: 'OK',
        toStatus: 'DO_NOT_CONTACT',
        origin: 'CARRY_OVER',
        relatedLeadId: old,
        changedBy: A.users.exec2.id,
      }),
    ]);
    // The returning customer's enquiry is not consent: only Owner/Admin can lift it.
    expect(await fieldsOf(lift(a.exec2, again))).toEqual(['toStatus']);
  });

  it('a bulk (import-style) insert carries do-not-contact too; nobody inserts a non-OK lead', async () => {
    const p = phone();
    const old = await created(a.admin, { primaryPhone: p });
    await dnc(a.admin, old);
    await leads.changeStage(a.admin.ctx, old, {
      toStage: 'LOST',
      version: (await row(old)).version,
      reasonCode: 'OTHER',
    });
    const src = (await row(old)).sourceId;
    const insert = (status: string, prev: string | null) =>
      asApp(A, A.users.admin.id, [
        `INSERT INTO lead (org_id, full_name, primary_phone_e164, primary_phone_raw, phone_last10,
                           source_id, stage, created_by, previous_lead_id, contact_status)
         VALUES ($1, 'Synthetic Import', $2, $2, right($2, 10), $3, 'NEW', $4, $5, $6)
         RETURNING id, contact_status`,
        [A.orgId, `+91${phone()}`, src, A.users.admin.id, prev, status],
      ]);
    const carried = await insert('OK', old);
    expect(carried.rows[0].contact_status).toBe('DO_NOT_CONTACT');
    expect(await events(carried.rows[0].id)).toHaveLength(1);
    expect(await sqlState(insert('INVALID', null))).toBe('23514');
    expect(await sqlState(insert('DO_NOT_CONTACT', null))).toBe('23514');
  });

  it('merging a do-not-contact duplicate makes the survivor do-not-contact', async () => {
    const survivor = await created(a.admin, { fullName: 'Synthetic Merge DNC' });
    const dup = await created(a.admin, { fullName: 'Synthetic Merge DNC' });
    await setStatus(a.admin, survivor, { toStatus: 'INVALID', reason: 'Wrong number' });
    await dnc(a.admin, dup);
    const preview = await leads.previewMerge(a.admin.ctx, { survivorId: survivor, mergedId: dup });
    expect(preview.carriesDoNotContact).toBe(true);
    await leads.mergeLeads(a.admin.ctx, {
      survivorId: survivor,
      mergedId: dup,
      survivorVersion: preview.survivorVersion,
      mergedVersion: preview.mergedVersion,
    });
    expect(await row(survivor)).toMatchObject({ contactStatus: 'DO_NOT_CONTACT' });
    expect(await row(dup)).toMatchObject({
      mergedIntoLeadId: survivor,
      contactStatus: 'DO_NOT_CONTACT',
    });
    expect((await events(survivor)).at(-1)).toMatchObject({
      fromStatus: 'INVALID',
      origin: 'MERGE',
      relatedLeadId: dup,
    });
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { action: 'lead.merged', entityId: survivor },
    });
    expect(audit.metadata).toMatchObject({ doNotContactCarried: true });
    // A merged (tombstone) lead accepts no contact status change.
    expect(await codeOf(setStatus(a.admin, dup, { toStatus: 'OK', reason: 'x' }))).toBe(
      'RULE_VIOLATION',
    );
  });

  it('an OK duplicate merged into a do-not-contact survivor changes nothing', async () => {
    const survivor = await created(a.admin, { fullName: 'Synthetic Merge Keep' });
    const dup = await created(a.admin, { fullName: 'Synthetic Merge Keep' });
    await dnc(a.admin, survivor);
    const preview = await leads.previewMerge(a.admin.ctx, { survivorId: survivor, mergedId: dup });
    expect(preview.carriesDoNotContact).toBe(false);
    await leads.mergeLeads(a.admin.ctx, {
      survivorId: survivor,
      mergedId: dup,
      survivorVersion: preview.survivorVersion,
      mergedVersion: preview.mergedVersion,
    });
    expect((await row(survivor)).contactStatus).toBe('DO_NOT_CONTACT');
    expect(await events(survivor)).toHaveLength(1);
  });
});

describe('database enforcement (crm_app)', () => {
  it('refuses a direct update of lead.contact_status, in either direction', async () => {
    const id = await created(a.admin);
    await dnc(a.admin, id);
    for (const to of ['OK', 'INVALID'])
      expect(
        await sqlState(
          asApp(A, A.users.owner.id, [
            `UPDATE lead SET contact_status = $2, version = version + 1 WHERE id = $1`,
            [id, to],
          ]),
        ),
      ).toBe('23514');
    // Even with a matching event row smuggled in first, the change must come from the trigger.
    const other = await created(a.admin);
    expect(
      await sqlState(
        asApp(
          A,
          A.users.owner.id,
          [
            `INSERT INTO lead_contact_status_event (org_id, lead_id, from_status, to_status, reason,
               changed_by)
             VALUES ($1, $2, 'OK', 'INVALID', 'x', $3)`,
            [A.orgId, other, A.users.owner.id],
          ],
          [`UPDATE lead SET contact_status = 'OK', version = version + 1 WHERE id = $1`, [other]],
        ),
      ),
    ).toBe('23514');
    expect((await row(id)).contactStatus).toBe('DO_NOT_CONTACT');
  });

  it('enforces the lift rules and the role matrix on event inserts', async () => {
    const id = await created(a.exec1);
    await dnc(a.exec1, id);
    const ev = (user: string, cols: string, vals: string) =>
      asApp(A, user, [
        `INSERT INTO lead_contact_status_event (org_id, lead_id, from_status, to_status, reason,
           changed_by${cols})
         VALUES ($1, $2, 'DO_NOT_CONTACT', 'OK', 'Lift', $3${vals})`,
        [A.orgId, id, user],
      ]);
    const full = [', method, evidence_ref', ", 'VERBAL', 'Call ref'"] as const;
    expect(await sqlState(ev(A.users.exec1.id, ...full))).toBe('42501'); // Sales Executive
    expect(await sqlState(ev(A.users.manager.id, ...full))).toBe('42501'); // Sales Manager
    expect(await sqlState(ev(A.users.hr.id, ...full))).toBe('42501'); // HR (RLS)
    expect(await sqlState(ev(A.users.admin.id, ', method', ", 'VERBAL'"))).toBe('23514'); // no evidence
    expect(await sqlState(ev(A.users.admin.id, '', ''))).toBe('23514'); // no basis
    // Forged actor or time.
    expect(
      await sqlState(
        asApp(A, A.users.admin.id, [
          `INSERT INTO lead_contact_status_event (org_id, lead_id, from_status, to_status, reason,
             method, evidence_ref, changed_by)
           VALUES ($1, $2, 'DO_NOT_CONTACT', 'OK', 'Lift', 'VERBAL', 'Ref', $3)`,
          [A.orgId, id, A.users.owner.id],
        ]),
      ),
    ).toBe('42501');
    // A wrong from_status, and weakening to INVALID.
    expect(
      await sqlState(
        asApp(A, A.users.owner.id, [
          `INSERT INTO lead_contact_status_event (org_id, lead_id, from_status, to_status, reason,
             changed_by)
           VALUES ($1, $2, 'OK', 'INVALID', 'x', $3)`,
          [A.orgId, id, A.users.owner.id],
        ]),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        asApp(A, A.users.owner.id, [
          `INSERT INTO lead_contact_status_event (org_id, lead_id, from_status, to_status, reason,
             changed_by)
           VALUES ($1, $2, 'DO_NOT_CONTACT', 'INVALID', 'x', $3)`,
          [A.orgId, id, A.users.owner.id],
        ]),
      ),
    ).toBe('23514');
    expect((await row(id)).contactStatus).toBe('DO_NOT_CONTACT');
    // The admin's complete lift works through the same path.
    await asApp(A, A.users.admin.id, [
      `INSERT INTO lead_contact_status_event (org_id, lead_id, from_status, to_status, reason,
         method, evidence_ref, changed_by)
       VALUES ($1, $2, 'DO_NOT_CONTACT', 'OK', 'Lift', 'VERBAL', 'Call ref', $3)`,
      [A.orgId, id, A.users.admin.id],
    ]);
    expect((await row(id)).contactStatus).toBe('OK');
  });

  it('keeps the evidence append-only and other orgs out', async () => {
    const id = await created(a.admin);
    await dnc(a.admin, id);
    const [e] = await events(id);
    for (const sql of [
      `UPDATE lead_contact_status_event SET reason = 'edited' WHERE id = $1`,
      `DELETE FROM lead_contact_status_event WHERE id = $1`,
    ])
      expect(await sqlState(asApp(A, A.users.owner.id, [sql, [e!.id]]))).toBe('42501');
    const seenByB = await asApp(B, B.users.owner.id, [
      `SELECT count(*)::int AS n FROM lead_contact_status_event WHERE lead_id = $1`,
      [id],
    ]);
    expect(seenByB.rows[0].n).toBe(0);
    expect(
      await sqlState(
        asApp(B, B.users.owner.id, [
          `INSERT INTO lead_contact_status_event (org_id, lead_id, from_status, to_status, method, reason)
           VALUES ($1, $2, 'DO_NOT_CONTACT', 'OK', NULL, 'x')`,
          [A.orgId, id],
        ]),
      ),
    ).toBe('23514'); // the guard cannot see another org's lead
    const hrSees = await asApp(A, A.users.hr.id, [
      `SELECT count(*)::int AS n FROM lead_contact_status_event WHERE lead_id = $1`,
      [id],
    ]);
    expect(hrSees.rows[0].n).toBe(0);
    expect(await events(id)).toEqual([e]);
  });

  it('refuses merging a do-not-contact lead into one that is not', async () => {
    const survivor = await created(a.admin);
    const dup = await created(a.admin);
    await dnc(a.admin, dup);
    expect(
      await sqlState(
        asApp(A, A.users.owner.id, [
          `UPDATE lead SET merged_into_lead_id = $2, version = version + 1 WHERE id = $1`,
          [dup, survivor],
        ]),
      ),
    ).toBe('23514');
  });
});

describe('outbound check (for future launchers)', () => {
  const check = (id: string, channel: leads.OutboundChannel, confirmed = false) =>
    codeOf(
      tenantRunner().withTenant(a.admin.ctx.tenant, (tx) =>
        leads.assertOutboundAllowed(tx, id, channel, { confirmed }),
      ),
    );

  it('blocks do-not-contact everywhere and asks for confirmation on an invalid number', async () => {
    const ok = await created(a.admin);
    const bad = await created(a.admin);
    const stop = await created(a.admin);
    await setStatus(a.admin, bad, { toStatus: 'INVALID', reason: 'Wrong number' });
    await dnc(a.admin, stop);
    for (const ch of leads.OUTBOUND_CHANNELS) {
      expect(await check(ok, ch)).toBe('OK');
      expect(await check(stop, ch)).toBe('RULE_VIOLATION');
      expect(await check(stop, ch, true)).toBe('RULE_VIOLATION'); // no override
    }
    expect(await check(bad, 'MANUAL_CALL')).toBe('RULE_VIOLATION');
    expect(await check(bad, 'MANUAL_CALL', true)).toBe('OK');
    expect(await check(bad, 'MANUAL_WHATSAPP', true)).toBe('OK');
    expect(await check(bad, 'INTEGRATION_MESSAGE', true)).toBe('RULE_VIOLATION');
    expect(await check(bad, 'INTEGRATION_CALL', true)).toBe('RULE_VIOLATION');
  });
});
