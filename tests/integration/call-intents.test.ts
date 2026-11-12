// FR-080/081/082 (migration 0028, ADR-0025): Call and WhatsApp taps record a call intent and
// return the link; scope, roles and other orgs; Do-Not-Contact refused and Invalid confirmed (app
// and database); with phone masking on, every tap is a capped, audited reveal; append-only rows;
// the outcome prompt until an outcome is logged or two hours pass. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as interactions from '@/modules/interactions';
import * as leads from '@/modules/leads';
import * as orgs from '@/modules/organizations';
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
const digits = () => String(70_000_000 + ++seq * 6_311 + (process.pid % 1000)).slice(-8);
async function created(by: Actor, input: Record<string, string> = {}) {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Caller',
    primaryPhone: `97${digits()}`,
    ...input,
  });
  if (r.status !== 'created') throw new Error('expected a new lead');
  return r.leadId;
}
const row = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const intents = (leadId: string) =>
  migrator().callIntent.findMany({ where: { leadId }, orderBy: { createdAt: 'asc' } });
const tap = (by: Actor, leadId: string, over: Record<string, unknown> = {}) =>
  interactions.recordCallIntent(by.ctx, { leadId, channel: 'PHONE_NATIVE', ...over });
const setStatus = async (by: Actor, id: string, body: Record<string, unknown>) =>
  leads.changeContactStatus(by.ctx, id, { version: (await row(id)).version, ...body });
const setMasking = (enabled: boolean, dailyCap = 50) =>
  orgs.updatePhoneMasking(a.owner.ctx, { enabled, dailyCap });

beforeAll(async () => {
  A = await seedOrg('CallA');
  B = await seedOrg('CallB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('taps (FR-080/081)', () => {
  it('Call returns tel:, WhatsApp returns wa.me, and each records an intent (not a call)', async () => {
    const id = await created(a.exec1);
    const e164 = (await row(id)).primaryPhoneE164;
    const call = await tap(a.exec1, id);
    expect(call.href).toBe(`tel:${e164}`);
    const wa = await tap(a.exec1, id, { channel: 'WHATSAPP_APP' });
    expect(wa.href).toBe(`https://wa.me/${e164.slice(1)}`);
    const rows = await intents(id);
    expect(rows.map((r) => [r.channel, r.numberKind, r.contactStatusAtTap, r.userId])).toEqual([
      ['PHONE_NATIVE', 'PRIMARY', 'OK', A.users.exec1.id],
      ['WHATSAPP_APP', 'PRIMARY', 'OK', A.users.exec1.id],
    ]);
    expect(rows.every((r) => r.phoneRevealId === null)).toBe(true);
    // Nothing else happens: no interaction, no stage change, no version change.
    expect(await migrator().interaction.count({ where: { leadId: id } })).toBe(0);
    expect((await row(id)).stage).toBe('ASSIGNED');
  });

  it('opens the alternate number only when the lead has one', async () => {
    const without = await created(a.exec1);
    expect(await codeOf(tap(a.exec1, without, { numberKind: 'ALTERNATE' }))).toBe('RULE_VIOLATION');
    const withAlt = await created(a.exec1, { alternatePhone: `98${digits()}` });
    const r = await tap(a.exec1, withAlt, { numberKind: 'ALTERNATE' });
    expect(r.href).toBe(`tel:${(await row(withAlt)).alternatePhoneE164}`);
  });

  it('follows interaction.create scope: own leads for executives, none for HR or other orgs', async () => {
    const id = await created(a.exec1);
    expect(await codeOf(tap(a.exec2, id))).toBe('NOT_FOUND');
    expect(await codeOf(tap(a.hr, id))).toBe('FORBIDDEN');
    expect(await codeOf(tap(ownerB, id))).toBe('NOT_FOUND');
    for (const k of ['owner', 'admin'] as const) expect(await codeOf(tap(a[k], id))).toBe('OK');
    expect(await codeOf(tap(a.exec1, 'not-a-uuid'))).not.toBe('OK');
    expect(await codeOf(tap(a.exec1, id, { channel: 'SMS' }))).toBe('VALIDATION_FAILED');
    expect((await intents(id)).map((r) => r.userId).sort()).toEqual(
      [A.users.owner.id, A.users.admin.id].sort(),
    );
  });

  it('refuses archived leads', async () => {
    const id = await created(a.exec1);
    await leads.archiveLead(a.admin.ctx, id, {
      version: (await row(id)).version,
      reason: 'Synthetic archive',
    });
    expect(await codeOf(tap(a.admin, id))).toBe('RULE_VIOLATION');
    expect(await intents(id)).toEqual([]);
  });
});

describe('contact status (FR-065)', () => {
  it('refuses both buttons on a Do-Not-Contact lead, with no override', async () => {
    const id = await created(a.exec1);
    await setStatus(a.exec1, id, {
      toStatus: 'DO_NOT_CONTACT',
      method: 'VERBAL',
      reason: 'Asked on a call',
    });
    for (const channel of ['PHONE_NATIVE', 'WHATSAPP_APP'])
      expect(await codeOf(tap(a.owner, id, { channel, confirmInvalidNumber: 'on' }))).toBe(
        'RULE_VIOLATION',
      );
    expect(await intents(id)).toEqual([]);
  });

  it('needs a confirmation on an Invalid number, and records it', async () => {
    const id = await created(a.exec1);
    await setStatus(a.exec1, id, { toStatus: 'INVALID', reason: 'Number not in service' });
    expect(await codeOf(tap(a.exec1, id))).toBe('RULE_VIOLATION');
    expect(await codeOf(tap(a.exec1, id, { confirmInvalidNumber: 'on' }))).toBe('OK');
    expect(
      (await intents(id)).map((r) => [r.contactStatusAtTap, r.invalidNumberConfirmed]),
    ).toEqual([['INVALID', true]]);
  });

  it('the database refuses what the app refuses (direct inserts as crm_app)', async () => {
    const id = await created(a.exec1);
    const insert = (status: string, confirmed = false, userId = A.users.exec1.id) =>
      sqlState(
        asApp(
          A,
          userId,
          `INSERT INTO call_intent (org_id, lead_id, user_id, channel, number_kind,
             contact_status_at_tap, invalid_number_confirmed)
           VALUES ($1, $2, $3, 'PHONE_NATIVE', 'PRIMARY', $4, $5)`,
          [A.orgId, id, userId, status, confirmed],
        ),
      );
    expect(await insert('OK')).toBe('OK');
    // A stale status, and a missing alternate number.
    expect(await insert('INVALID')).toBe('23514');
    expect(
      await sqlState(
        asApp(
          A,
          A.users.exec1.id,
          `INSERT INTO call_intent (org_id, lead_id, user_id, channel, number_kind,
             contact_status_at_tap) VALUES ($1, $2, $3, 'PHONE_NATIVE', 'ALTERNATE', 'OK')`,
          [A.orgId, id, A.users.exec1.id],
        ),
      ),
    ).toBe('23514');
    await setStatus(a.exec1, id, { toStatus: 'INVALID', reason: 'Number not in service' });
    expect(await insert('INVALID')).toBe('23514');
    expect(await insert('INVALID', true)).toBe('OK');
    await setStatus(a.exec1, id, {
      toStatus: 'DO_NOT_CONTACT',
      method: 'WRITTEN',
      reason: 'Asked by message',
    });
    expect(await insert('DO_NOT_CONTACT', true)).toBe('23514');
    // HR cannot insert at all.
    expect(await insert('DO_NOT_CONTACT', true, A.users.hr.id)).not.toBe('OK');
  });

  it('is append-only: no UPDATE or DELETE for the app role', async () => {
    const id = await created(a.exec1);
    await tap(a.exec1, id);
    const [r] = await intents(id);
    expect(
      await sqlState(
        asApp(
          A,
          A.users.exec1.id,
          `UPDATE call_intent SET channel = 'WHATSAPP_APP' WHERE id = $1`,
          [r!.id],
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(asApp(A, A.users.exec1.id, `DELETE FROM call_intent WHERE id = $1`, [r!.id])),
    ).toBe('42501');
  });
});

describe('phone masking (FR-060: dialling a masked number is a reveal)', () => {
  it('records a capped, audited reveal with each tap and links it to the intent', async () => {
    const id = await created(a.exec2);
    await setMasking(true, 2);
    try {
      const first = await tap(a.exec2, id);
      expect(first.href).toBe(`tel:${(await row(id)).primaryPhoneE164}`);
      await tap(a.exec2, id, { channel: 'WHATSAPP_APP' });
      // The cap counts taps and reveals together: the third is refused and records nothing.
      expect(await codeOf(tap(a.exec2, id))).toBe('RULE_VIOLATION');
      expect(await codeOf(leads.revealLeadPhone(a.exec2.ctx, id))).toBe('RULE_VIOLATION');
      const rows = await intents(id);
      expect(rows).toHaveLength(2);
      const reveals = await migrator().leadPhoneReveal.findMany({ where: { leadId: id } });
      expect(reveals).toHaveLength(2);
      expect(rows.map((r) => r.phoneRevealId).sort()).toEqual(reveals.map((r) => r.id).sort());
      expect(
        await migrator().auditLog.count({
          where: { action: 'lead.phone_revealed', entityId: id },
        }),
      ).toBe(2);
    } finally {
      await setMasking(false);
    }
  });

  it('the database refuses a tap without this transaction’s reveal while masking is on', async () => {
    const id = await created(a.exec1);
    await setMasking(true);
    try {
      expect(
        await sqlState(
          asApp(
            A,
            A.users.exec1.id,
            `INSERT INTO call_intent (org_id, lead_id, user_id, channel, number_kind,
               contact_status_at_tap) VALUES ($1, $2, $3, 'PHONE_NATIVE', 'PRIMARY', 'OK')`,
            [A.orgId, id, A.users.exec1.id],
          ),
        ),
      ).toBe('23514');
    } finally {
      await setMasking(false);
    }
  });
});

describe('the outcome prompt (FR-082)', () => {
  it('shows the latest tap until the person logs an outcome on that lead', async () => {
    const id = await created(a.exec1);
    expect(await interactions.pendingCallIntent(a.exec1.ctx, id)).toBeNull();
    await tap(a.exec1, id);
    const { intentId } = await tap(a.exec1, id, { channel: 'WHATSAPP_APP' });
    const p = await interactions.pendingCallIntent(a.exec1.ctx, id);
    expect(p).toMatchObject({ id: intentId, channel: 'WHATSAPP_APP' });
    expect(p!.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // Someone else's tap is not their prompt.
    expect(await interactions.pendingCallIntent(a.owner.ctx, id)).toBeNull();
    await interactions.logInteraction(a.exec1.ctx, {
      leadId: id,
      idempotencyKey: randomUUID(),
      version: (await row(id)).version,
      channel: 'WHATSAPP_APP_MESSAGE',
      direction: 'OUTBOUND',
      outcome: 'MESSAGE_SENT',
      occurredAt: p!.occurredAt,
    });
    expect(await interactions.pendingCallIntent(a.exec1.ctx, id)).toBeNull();
  });

  it('expires two hours after the tap, and is never shown to HR', async () => {
    const id = await created(a.exec1);
    await tap(a.exec1, id);
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000 + 60_000);
    expect(await interactions.pendingCallIntent(a.exec1.ctx, id, later)).toBeNull();
    expect(await codeOf(interactions.pendingCallIntent(a.hr.ctx, id))).toBe('FORBIDDEN');
    expect(await interactions.pendingCallIntent(a.exec1.ctx, 'nope')).toBeNull();
  });
});
