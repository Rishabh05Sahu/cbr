// Phase 3 slice 8 (migration 0017): FR-083 manual interaction logging, FR-084 the one-submit
// outcome sheet and FR-085 interactions on the timeline. One transaction per submission
// (requirements, interaction, timeline, stage, contact status, follow-up), idempotency under
// retries and concurrency, the Do-Not-Contact / Invalid rules (owner decisions Q1–Q3), the
// lifecycle rule (Q5), roles, scope, other orgs, and the database's own guarantees (append-only,
// stamped actor and time, tenant isolation, read policy, CHECKs). Synthetic data only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as interactions from '@/modules/interactions';
import * as leads from '@/modules/leads';
import * as scripts from '@/modules/scripts';
import * as tasks from '@/modules/tasks';
import * as teams from '@/modules/teams';
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
/** Statements as crm_app in one transaction, the way withTenant() connects. */
async function asApp(
  orgId: string,
  userId: string,
  sql: string,
  params: unknown[] = [],
  readOnly = false,
) {
  return withRole(APP, async (c) => {
    await c.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [orgId, userId],
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

/** "YYYY-MM-DDTHH:MM" in Asia/Kolkata (the org's time zone), `minutes` from now. */
function local(minutes: number): string {
  return interactions.orgLocalInputValue(new Date(Date.now() + minutes * 60_000), 'Asia/Kolkata');
}

let seq = 0;
const phone = () => `96${String(40_000_000 + ++seq * 7_717 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor, name = 'Synthetic Interaction'): Promise<string> {
  const r = await leads.createLead(by.ctx, { fullName: name, primaryPhone: phone() });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
const row = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const logged = (leadId: string) =>
  migrator().interaction.findMany({ where: { leadId }, orderBy: { loggedAt: 'asc' } });
const activity = (leadId: string, type?: string) =>
  migrator().leadActivity.findMany({
    where: { leadId, ...(type ? { type } : {}) },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
const statusEvents = (leadId: string) =>
  migrator().leadContactStatusEvent.findMany({ where: { leadId } });

/** One sheet submission with sensible defaults; the lead's current version unless given. */
async function log(by: Actor, leadId: string, over: Record<string, unknown> = {}) {
  return interactions.logInteraction(by.ctx, {
    leadId,
    idempotencyKey: randomUUID(),
    version: (await row(leadId)).version,
    channel: 'PHONE_NATIVE',
    direction: 'OUTBOUND',
    outcome: 'CONNECTED_INTERESTED',
    occurredAt: local(-5),
    ...over,
  });
}
const dnc = async (by: Actor, id: string) =>
  leads.changeContactStatus(by.ctx, id, {
    toStatus: 'DO_NOT_CONTACT',
    version: (await row(id)).version,
    method: 'VERBAL',
    reason: 'Asked on a call',
  });
const invalidNumber = async (by: Actor, id: string) =>
  leads.changeContactStatus(by.ctx, id, {
    toStatus: 'INVALID',
    version: (await row(id)).version,
    reason: 'Number does not exist',
  });

beforeAll(async () => {
  A = await seedOrg('InteractA');
  B = await seedOrg('InteractB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  const west = (await teams.createTeam(a.owner.ctx, { name: 'West' })).id;
  await teams.addTeamMember(a.owner.ctx, {
    teamId: west,
    membershipId: A.membership.manager!,
    teamRole: 'LEAD',
  });
  await teams.addTeamMember(a.owner.ctx, {
    teamId: west,
    membershipId: A.membership.exec1!,
    teamRole: 'MEMBER',
  });
});

describe('logging and the timeline (FR-083, FR-085)', () => {
  it('saves a manual interaction and its timeline entry; notes stay off the summary', async () => {
    const id = await created(a.exec1);
    const r = await log(a.exec1, id, {
      outcome: 'NO_ANSWER',
      durationMinutes: '',
      notes: '  Synthetic note: rang twice  ',
    });
    expect(r).toMatchObject({ duplicate: false, stageChangedTo: null, followUp: null });
    const [ix] = await logged(id);
    expect(ix).toMatchObject({
      orgId: A.orgId,
      userId: A.users.exec1.id,
      channel: 'PHONE_NATIVE',
      direction: 'OUTBOUND',
      source: 'MANUAL',
      status: 'LOGGED',
      outcome: 'NO_ANSWER',
      outcomeGroup: 'NOT_CONNECTED',
      notes: 'Synthetic note: rang twice',
      contactStatusAtLog: 'OK',
      invalidNumberConfirmed: false,
      manualDurationMinutes: null,
    });
    const [entry] = await activity(id, 'INTERACTION');
    expect(entry).toMatchObject({
      actorId: A.users.exec1.id,
      refType: 'interaction',
      refId: ix!.id,
    });
    expect(entry!.summary).toMatchObject({ source: 'MANUAL', outcome: 'NO_ANSWER' });
    expect(JSON.stringify(entry!.summary)).not.toContain('Synthetic note');
    // "No answer" never moves the stage or sets a milestone.
    expect(await row(id)).toMatchObject({ stage: 'ASSIGNED', firstContactedAt: null });
    // The timeline shows the notes to people with interaction.read.
    const timeline = await leads.getTimeline(a.exec1.ctx, id);
    expect(timeline.find((t) => t.type === 'INTERACTION')?.interaction?.notes).toBe(
      'Synthetic note: rang twice',
    );
  });

  it('moves Assigned to Contacted on the first connected outcome; the milestone is set once', async () => {
    const id = await created(a.exec1);
    const r = await log(a.exec1, id, { outcome: 'CONNECTED_CALL_BACK', durationMinutes: '4' });
    expect(r.stageChangedTo).toBe('CONTACTED');
    const after = await row(id);
    expect(after.stage).toBe('CONTACTED');
    expect(after.firstContactedAt).not.toBeNull();
    const history = await migrator().leadStageHistory.findMany({
      where: { leadId: id, toStage: 'CONTACTED' },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      source: 'SYSTEM_RULE',
      reasonCode: 'FIRST_CONNECTED_INTERACTION',
      changedBy: A.users.exec1.id,
    });
    expect(
      await migrator().auditLog.count({
        where: {
          entityId: id,
          action: 'lead.stage_changed',
          metadata: { path: ['rule'], equals: 'FIRST_CONNECTED_INTERACTION' },
        },
      }),
    ).toBe(1);
    const again = await log(a.exec1, id, { outcome: 'CONNECTED_INTERESTED' });
    expect(again.stageChangedTo).toBeNull();
    expect((await row(id)).firstContactedAt).toEqual(after.firstContactedAt);
    // Timeline: newest first by logged time; the stage entry follows its interaction.
    const types = (await leads.getTimeline(a.exec1.ctx, id)).map((t) => t.type);
    expect(types.slice(0, 3)).toEqual(['INTERACTION', 'STAGE', 'INTERACTION']);
  });

  it('a connected outcome on New, Won or Lost changes no stage and sets no milestone (L2)', async () => {
    const queued = await created(a.admin);
    await leads.assignLead(a.admin.ctx, queued, {
      target: 'queue',
      version: (await row(queued)).version,
      reason: 'Back to the queue',
    });
    expect((await row(queued)).stage).toBe('NEW');
    expect((await log(a.admin, queued)).stageChangedTo).toBeNull();
    expect(await row(queued)).toMatchObject({ stage: 'NEW', firstContactedAt: null });

    // Won: set by the maintenance role (the deal flow is Phase 5); the lead was never contacted.
    const won = await created(a.exec1);
    await migrator().lead.update({ where: { id: won }, data: { stage: 'WON', wonAt: new Date() } });
    const wonBefore = await row(won);
    await log(a.exec1, won, { direction: 'INBOUND', outcome: 'CONNECTED_INTERESTED' });
    expect(await row(won)).toMatchObject({
      stage: 'WON',
      firstContactedAt: null,
      version: wonBefore.version,
    });

    const lost = await created(a.exec1);
    await leads.changeStage(a.exec1.ctx, lost, {
      toStage: 'LOST',
      version: (await row(lost)).version,
      reasonCode: 'NOT_REACHABLE',
    });
    const lostBefore = await row(lost);
    await log(a.exec1, lost, { direction: 'INBOUND' });
    expect(await row(lost)).toMatchObject({
      stage: 'LOST',
      firstContactedAt: null,
      version: lostBefore.version,
    });
    expect(
      await migrator().leadStageHistory.count({
        where: { leadId: { in: [queued, won, lost] }, reasonCode: 'FIRST_CONNECTED_INTERACTION' },
      }),
    ).toBe(0);
    // No follow-ups on closed leads, and the refusal saves nothing.
    expect(await codeOf(log(a.exec1, lost, { direction: 'INBOUND', nextDueAt: local(60) }))).toBe(
      'RULE_VIOLATION',
    );
    expect(await logged(lost)).toHaveLength(1);
  });
});

describe('one submission, one transaction (FR-084)', () => {
  it('saves requirements, the interaction and the follow-up change together', async () => {
    const id = await created(a.exec1);
    const { id: taskId } = await tasks.scheduleFollowUp(a.exec1.ctx, id, { dueAt: local(120) });
    const task = await migrator().task.findUniqueOrThrow({ where: { id: taskId } });
    const r = await log(a.exec1, id, {
      requirementFields: 'preferredCity,budgetMin,budgetMax,bhkMin',
      preferredCity: 'Pune',
      budgetMin: '5000000',
      budgetMax: '8000000',
      bhkMin: '2',
      followUpTaskId: taskId,
      followUpVersion: String(task.version),
      completeFollowUp: 'on',
      nextDueAt: local(24 * 60),
      nextTitle: 'Send the shortlist',
    });
    expect(r).toMatchObject({ followUp: 'completed_and_scheduled', stageChangedTo: 'CONTACTED' });
    expect(r.requirementsChanged.sort()).toEqual([
      'bhkMin',
      'budgetMax',
      'budgetMin',
      'preferredCity',
    ]);
    expect(await row(id)).toMatchObject({ preferredCity: 'Pune', bhkMin: 2, stage: 'CONTACTED' });
    const open = await migrator().task.findMany({ where: { leadId: id, status: 'OPEN' } });
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toBe('Send the shortlist');
    expect((await migrator().task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe(
      'DONE',
    );
    expect((await activity(id)).map((x) => x.type)).toEqual(
      expect.arrayContaining(['FIELD_CHANGED', 'INTERACTION', 'STAGE', 'TASK']),
    );
  });

  it('reschedules the own follow-up with the FR-102 reason rule', async () => {
    const id = await created(a.exec1);
    const { id: taskId } = await tasks.scheduleFollowUp(a.exec1.ctx, id, { dueAt: local(60) });
    const v = (await migrator().task.findUniqueOrThrow({ where: { id: taskId } })).version;
    const r = await log(a.exec1, id, {
      outcome: 'NO_ANSWER',
      followUpTaskId: taskId,
      followUpVersion: String(v),
      nextDueAt: local(180),
    });
    expect(r.followUp).toBe('rescheduled');
    expect(await migrator().task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      status: 'OPEN',
      rescheduleCount: 1,
    });
  });

  it('a refused part rolls everything back: no interaction, stage, requirements or timeline', async () => {
    const id = await created(a.exec1);
    await tasks.scheduleFollowUp(a.exec1.ctx, id, { dueAt: local(60) });
    const before = await row(id);
    const entries = (await activity(id)).length;
    // A stale form that still offers "next follow-up" although one is open: the follow-up step
    // fails after the interaction, stage and requirements were written in the same transaction.
    expect(
      await codeOf(
        log(a.exec1, id, {
          requirementFields: 'preferredCity',
          preferredCity: 'Nagpur',
          nextDueAt: local(300),
        }),
      ),
    ).toBe('CONFLICT');
    expect(await logged(id)).toHaveLength(0);
    expect(await row(id)).toMatchObject({
      stage: 'ASSIGNED',
      preferredCity: before.preferredCity,
      version: before.version,
      firstContactedAt: null,
    });
    expect(await activity(id)).toHaveLength(entries);
    // Invalid requirements, a stale version with changed requirements, a future time: refused.
    expect(
      await fieldsOf(
        log(a.exec1, id, {
          requirementFields: 'budgetMin,budgetMax',
          budgetMin: '9000000',
          budgetMax: '100',
        }),
      ),
    ).toEqual(['budgetMax']);
    expect(
      await codeOf(
        log(a.exec1, id, {
          requirementFields: 'preferredCity',
          preferredCity: 'Thane',
          version: before.version + 7,
        }),
      ),
    ).toBe('CONFLICT');
    expect(await fieldsOf(log(a.exec1, id, { occurredAt: local(30) }))).toEqual(['occurredAt']);
    expect(await fieldsOf(log(a.exec1, id, { occurredAt: local(-8 * 24 * 60) }))).toEqual([
      'occurredAt',
    ]);
    expect(await fieldsOf(log(a.exec1, id, { outcome: 'MESSAGE_SENT' }))).toEqual(['outcome']);
    expect(await codeOf(log(a.exec1, id, { outcome: '' }))).toBe('VALIDATION_FAILED'); // zod
    expect(await fieldsOf(log(a.exec1, id, { channel: 'EMAIL', durationMinutes: '5' }))).toEqual([
      'durationMinutes',
    ]);
    expect(await logged(id)).toHaveLength(0);
  });

  it('a repeated submission returns the first result and writes nothing again', async () => {
    const id = await created(a.exec1);
    const key = randomUUID();
    const body = {
      idempotencyKey: key,
      version: (await row(id)).version,
      nextDueAt: local(90),
      notes: 'Synthetic retry note',
    };
    const first = await log(a.exec1, id, body);
    const second = await log(a.exec1, id, { ...body, notes: '  Synthetic retry note  ' });
    expect(first).toMatchObject({ duplicate: false, followUp: 'scheduled' });
    // Same details after normalisation (trimmed notes): the first result, nothing written again.
    expect(second).toMatchObject({ duplicate: true, interactionId: first.interactionId });
    expect((await logged(id))[0]!.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await logged(id)).toHaveLength(1);
    expect(await migrator().task.count({ where: { leadId: id } })).toBe(1);
    expect(await activity(id, 'INTERACTION')).toHaveLength(1);
    // The same key cannot be reused for another lead.
    const other = await created(a.exec1);
    expect(await codeOf(log(a.exec1, other, { idempotencyKey: key }))).toBe('CONFLICT');
    expect(await logged(other)).toHaveLength(0);
  });

  it('concurrent submissions with one key create one interaction and one set of side effects', async () => {
    const id = await created(a.exec1);
    const version = (await row(id)).version;
    const body = {
      leadId: id,
      idempotencyKey: randomUUID(),
      version,
      channel: 'WHATSAPP_APP_CALL',
      direction: 'OUTBOUND',
      outcome: 'CONNECTED_INTERESTED',
      occurredAt: local(-2),
      nextDueAt: local(240),
    };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => interactions.logInteraction(a.exec1.ctx, body)),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.interactionId)).size).toBe(1);
    expect(await logged(id)).toHaveLength(1);
    expect(await migrator().task.count({ where: { leadId: id } })).toBe(1);
    expect(
      await migrator().leadStageHistory.count({ where: { leadId: id, toStage: 'CONTACTED' } }),
    ).toBe(1);
  });
});

describe('contact status (FR-065; owner decisions Q1–Q3)', () => {
  it('refuses outbound contact on a do-not-contact lead, in the app and in the database (Q2)', async () => {
    const id = await created(a.exec1);
    await dnc(a.exec1, id);
    for (const channel of interactions.CHANNELS)
      expect(
        await fieldsOf(
          log(a.exec1, id, { channel, outcome: 'CONNECTED_INTERESTED', direction: 'OUTBOUND' }),
        ),
      ).toEqual(['direction']);
    expect(
      await sqlState(
        asApp(
          A.orgId,
          A.users.exec1.id,
          `INSERT INTO interaction (org_id, lead_id, user_id, channel, direction, outcome,
             outcome_group, occurred_at, contact_status_at_log, client_idempotency_key,
             request_fingerprint)
           VALUES ($1, $2, $3, 'PHONE_NATIVE', 'OUTBOUND', 'CONNECTED_INTERESTED', 'CONNECTED',
             now(), 'DO_NOT_CONTACT', gen_random_uuid(), repeat('a', 64))`,
          [A.orgId, id, A.users.exec1.id],
        ),
      ),
    ).toBe('23514');
    expect(await logged(id)).toHaveLength(0);
  });

  it('records inbound contact on a do-not-contact lead without changing it (Q1)', async () => {
    const id = await created(a.exec1);
    await dnc(a.exec1, id);
    const eventsBefore = (await statusEvents(id)).length;
    await log(a.exec1, id, { direction: 'INBOUND', outcome: 'CONNECTED_NOT_INTERESTED' });
    const asked = await log(a.exec1, id, {
      direction: 'INBOUND',
      outcome: 'CONNECTED_DO_NOT_CALL',
    });
    expect(asked.contactStatusChangedTo).toBeNull();
    expect(asked.contactStatusNote).toMatch(/already marked do not contact/);
    const wrong = await log(a.exec1, id, { direction: 'INBOUND', outcome: 'WRONG_NUMBER' });
    expect(wrong.contactStatusChangedTo).toBeNull(); // never weakened to Invalid
    expect((await row(id)).contactStatus).toBe('DO_NOT_CONTACT');
    expect(await statusEvents(id)).toHaveLength(eventsBefore);
    expect((await logged(id)).every((x) => x.contactStatusAtLog === 'DO_NOT_CONTACT')).toBe(true);
    // Still no outbound contact afterwards.
    expect(await fieldsOf(log(a.exec1, id))).toEqual(['direction']);
  });

  it('"asked not to be contacted" sets do-not-contact only with confirmation and details (Q3)', async () => {
    const id = await created(a.exec1);
    expect(await fieldsOf(log(a.exec1, id, { outcome: 'CONNECTED_DO_NOT_CALL' }))).toEqual([
      'confirmStatusChange',
      'statusMethod',
      'statusReason',
    ]);
    expect(await logged(id)).toHaveLength(0);
    const r = await log(a.exec1, id, {
      outcome: 'CONNECTED_DO_NOT_CALL',
      confirmStatusChange: 'on',
      statusMethod: 'VERBAL',
      statusReason: 'Said stop calling',
      statusEvidenceRef: 'Synthetic call 7',
    });
    expect(r).toMatchObject({
      contactStatusChangedTo: 'DO_NOT_CONTACT',
      stageChangedTo: 'CONTACTED',
    });
    const [ev] = await statusEvents(id);
    expect(ev).toMatchObject({
      fromStatus: 'OK',
      toStatus: 'DO_NOT_CONTACT',
      origin: 'MANUAL',
      method: 'VERBAL',
      reason: 'Said stop calling',
      evidenceRef: 'Synthetic call 7',
      changedBy: A.users.exec1.id,
    });
    expect((await row(id)).contactStatus).toBe('DO_NOT_CONTACT');
    expect((await logged(id))[0]!.contactStatusAtLog).toBe('OK');
    expect((await activity(id)).map((x) => x.type)).toEqual(
      expect.arrayContaining(['INTERACTION', 'CONTACT_STATUS']),
    );
    // Only an Owner/Admin lifts it; nothing in the sheet can.
    expect(await fieldsOf(log(a.admin, id))).toEqual(['direction']);
  });

  it('a wrong-number outcome marks the number invalid only with confirmation; invalid needs confirming', async () => {
    const id = await created(a.exec1);
    expect(await fieldsOf(log(a.exec1, id, { outcome: 'WRONG_NUMBER' }))).toEqual([
      'confirmStatusChange',
      'statusReason',
    ]);
    const r = await log(a.exec1, id, {
      outcome: 'WRONG_NUMBER',
      confirmStatusChange: 'on',
      statusReason: 'Someone else answers',
    });
    expect(r.contactStatusChangedTo).toBe('INVALID');
    expect((await row(id)).contactStatus).toBe('INVALID');
    // Outbound contact on an invalid number needs the confirmation (app and database).
    expect(await fieldsOf(log(a.exec1, id, { outcome: 'NO_ANSWER' }))).toEqual([
      'confirmInvalidNumber',
    ]);
    await log(a.exec1, id, { outcome: 'NO_ANSWER', confirmInvalidNumber: 'on' });
    expect((await logged(id)).at(-1)).toMatchObject({
      invalidNumberConfirmed: true,
      contactStatusAtLog: 'INVALID',
    });
    expect(
      await sqlState(
        asApp(
          A.orgId,
          A.users.exec1.id,
          `INSERT INTO interaction (org_id, lead_id, user_id, channel, direction, outcome,
             outcome_group, occurred_at, contact_status_at_log, client_idempotency_key,
             request_fingerprint)
           VALUES ($1, $2, $3, 'PHONE_NATIVE', 'OUTBOUND', 'NO_ANSWER', 'NOT_CONNECTED', now(),
             'INVALID', gen_random_uuid(), repeat('a', 64))`,
          [A.orgId, id, A.users.exec1.id],
        ),
      ),
    ).toBe('23514');
    // Inbound contact on an invalid number needs no confirmation and changes nothing.
    await log(a.exec1, id, { direction: 'INBOUND', outcome: 'CONNECTED_INTERESTED' });
    expect((await row(id)).contactStatus).toBe('INVALID');
  });

  it('logging never reveals a number or records a reveal', async () => {
    expect(await migrator().leadPhoneReveal.count({ where: { orgId: A.orgId } })).toBe(0);
  });
});

describe('idempotency with request fingerprints (review M1, migration 0018)', () => {
  /** Every side-effect count for a lead, to prove a refused retry wrote nothing. */
  async function effects(id: string) {
    const l = await row(id);
    return {
      interactions: (await logged(id)).length,
      activity: (await activity(id)).length,
      tasks: await migrator().task.count({ where: { leadId: id } }),
      openTasks: await migrator().task.count({ where: { leadId: id, status: 'OPEN' } }),
      events: (await statusEvents(id)).length,
      history: await migrator().leadStageHistory.count({ where: { leadId: id } }),
      audit: await migrator().auditLog.count({ where: { entityId: id } }),
      lead: [l.version, l.stage, l.contactStatus, l.preferredCity].join('|'),
    };
  }
  async function firstSave(extra: Record<string, unknown> = {}) {
    const id = await created(a.exec1);
    const body = {
      idempotencyKey: randomUUID(),
      version: (await row(id)).version,
      outcome: 'CONNECTED_INTERESTED',
      ...extra,
    };
    const first = await log(a.exec1, id, body);
    return { id, body, first, after: await effects(id) };
  }
  const changedDetails = /already saved, with different details/;
  async function messageOf(p: Promise<unknown>) {
    try {
      await p;
      return 'OK';
    } catch (e) {
      return e instanceof DomainError ? `${e.code}: ${e.message}` : String(e);
    }
  }

  it('refuses a retry with a changed outcome (for example a stop request) and writes nothing', async () => {
    const { id, body, after } = await firstSave();
    const msg = await messageOf(
      log(a.exec1, id, {
        ...body,
        outcome: 'CONNECTED_DO_NOT_CALL',
        confirmStatusChange: 'on',
        statusMethod: 'VERBAL',
        statusReason: 'Said stop',
      }),
    );
    expect(msg).toMatch(/^CONFLICT: /);
    expect(msg).toMatch(changedDetails);
    expect(await effects(id)).toEqual(after);
    expect((await row(id)).contactStatus).toBe('OK');
  });

  it('refuses a retry with changed requirements and writes nothing', async () => {
    const { id, body, after } = await firstSave({
      requirementFields: 'preferredCity',
      preferredCity: 'Pune',
    });
    expect(
      await messageOf(
        log(a.exec1, id, { ...body, requirementFields: 'preferredCity', preferredCity: 'Thane' }),
      ),
    ).toMatch(changedDetails);
    expect(
      await messageOf(log(a.exec1, id, { ...body, requirementFields: '', preferredCity: '' })),
    ).toMatch(changedDetails);
    expect(await effects(id)).toEqual(after);
    expect((await row(id)).preferredCity).toBe('Pune');
  });

  it('refuses a retry with changed follow-up details and writes nothing', async () => {
    const { id, body, after } = await firstSave({ nextDueAt: local(120), nextTitle: 'Call back' });
    for (const change of [
      { nextDueAt: local(240) },
      { nextTitle: 'Send brochure' },
      { nextDueAt: '', nextTitle: '' },
    ])
      expect(await messageOf(log(a.exec1, id, { ...body, ...change }))).toMatch(changedDetails);
    expect(await effects(id)).toEqual(after);
  });

  it('answers an identical retry from the first save, also when submissions race', async () => {
    const { id, body, first, after } = await firstSave({ nextDueAt: local(60) });
    const again = await log(a.exec1, id, body);
    expect(again).toMatchObject({ duplicate: true, interactionId: first.interactionId });
    expect(await effects(id)).toEqual(after);

    const other = await created(a.exec1);
    const raced = {
      leadId: other,
      idempotencyKey: randomUUID(),
      version: (await row(other)).version,
      channel: 'PHONE_NATIVE',
      direction: 'OUTBOUND',
      outcome: 'CONNECTED_CALL_BACK',
      occurredAt: local(-3),
      nextDueAt: local(300),
      requirementFields: 'intent',
      intent: 'HOT',
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => interactions.logInteraction(a.exec1.ctx, raced)),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.interactionId)).size).toBe(1);
    expect(await effects(other)).toMatchObject({ interactions: 1, tasks: 1, openTasks: 1 });
    expect(
      await migrator().leadActivity.count({ where: { leadId: other, type: 'FIELD_CHANGED' } }),
    ).toBe(1);
  });

  it('refuses a retry against a row from before 0018 (no fingerprint): it cannot be verified', async () => {
    const { id, body, first, after } = await firstSave();
    // Simulate a pre-0018 row (the maintenance role; crm_app cannot update interactions).
    await migrator().interaction.update({
      where: { id: first.interactionId },
      data: { requestFingerprint: null },
    });
    const msg = await messageOf(log(a.exec1, id, body));
    expect(msg).toMatch(/^CONFLICT: /);
    expect(msg).toMatch(/cannot be compared/);
    expect(await effects(id)).toEqual(after);
  });

  it('a new row without a fingerprint is refused by the database', async () => {
    const id = await created(a.exec1);
    expect(
      await sqlState(
        asApp(
          A.orgId,
          A.users.exec1.id,
          `INSERT INTO interaction (org_id, lead_id, user_id, channel, direction, outcome,
             outcome_group, occurred_at, contact_status_at_log, client_idempotency_key)
           VALUES ($1, $2, $3, 'PHONE_NATIVE', 'OUTBOUND', 'NO_ANSWER', 'NOT_CONNECTED', now(),
             'OK', gen_random_uuid())`,
          [A.orgId, id, A.users.exec1.id],
        ),
      ),
    ).toBe('23514');
  });

  it('someone who lost access gets "not found", never the earlier result', async () => {
    const id = await created(a.exec1);
    const body = { idempotencyKey: randomUUID(), version: (await row(id)).version };
    await log(a.exec1, id, body);
    await leads.assignLead(a.admin.ctx, id, {
      target: `user:${A.users.exec2.id}`,
      version: (await row(id)).version,
      reason: 'Synthetic reassignment',
    });
    expect(await codeOf(log(a.exec1, id, body))).toBe('NOT_FOUND');
  });
});

describe('requirements are a patch of what the person changed (review L1)', () => {
  it('an untouched sheet saves although someone else changed the requirements meanwhile', async () => {
    const id = await created(a.exec1);
    const pageVersion = (await row(id)).version; // the form was rendered with this version
    await leads.updateRequirements(a.admin.ctx, id, {
      version: pageVersion,
      preferredCity: 'Pune',
      intent: 'HOT',
    });
    const r = await log(a.exec1, id, {
      version: pageVersion,
      // The browser sends no requirement values for untouched fields.
      requirementFields: '',
    });
    expect(r.requirementsChanged).toEqual([]);
    expect(await row(id)).toMatchObject({ preferredCity: 'Pune', intent: 'HOT' });
  });

  it('a changed field merges onto the stored values without clearing the others', async () => {
    const id = await created(a.exec1);
    await leads.updateRequirements(a.exec1.ctx, id, {
      version: (await row(id)).version,
      preferredCity: 'Pune',
      budgetMin: '4000000',
    });
    const r = await log(a.exec1, id, { requirementFields: 'intent', intent: 'WARM' });
    expect(r.requirementsChanged).toEqual(['intent']);
    expect(await row(id)).toMatchObject({ preferredCity: 'Pune', intent: 'WARM' });
    expect((await row(id)).budgetMin?.toFixed(2)).toBe('4000000.00');
  });

  it('a real edit on a lead that changed since the page loaded is refused; nothing is saved', async () => {
    const id = await created(a.exec1);
    const pageVersion = (await row(id)).version;
    await leads.updateRequirements(a.admin.ctx, id, {
      version: pageVersion,
      preferredCity: 'Pune',
    });
    const before = await row(id);
    const entries = (await activity(id)).length;
    let err: DomainError | null = null;
    try {
      await log(a.exec1, id, {
        version: pageVersion,
        requirementFields: 'preferredCity',
        preferredCity: 'Thane',
        nextDueAt: local(60),
      });
    } catch (e) {
      err = e as DomainError;
    }
    expect(err).toBeInstanceOf(DomainError);
    expect(err!.code).toBe('CONFLICT');
    expect(Object.keys(err!.fieldErrors ?? {})).toEqual(['requirements']);
    expect(await row(id)).toMatchObject({ preferredCity: 'Pune', version: before.version });
    expect(await logged(id)).toHaveLength(0);
    expect(await activity(id)).toHaveLength(entries);
    expect(await migrator().task.count({ where: { leadId: id } })).toBe(0);
  });

  it('refuses unknown requirement field names', async () => {
    const id = await created(a.exec1);
    expect(await fieldsOf(log(a.exec1, id, { requirementFields: 'ownerUserId' }))).toEqual(['_']);
  });
});

describe('review L3 and L5', () => {
  it('scheduleFollowUp checks permission before validating input', async () => {
    const id = await created(a.exec1);
    expect(await codeOf(tasks.scheduleFollowUp(a.hr.ctx, id, { dueAt: 'x'.repeat(50) }))).toBe(
      'FORBIDDEN',
    );
    // Authorised callers still get the validation message.
    expect(await codeOf(tasks.scheduleFollowUp(a.exec1.ctx, id, { dueAt: 'x'.repeat(50) }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('a reschedule reason or follow-up title without its follow-up is refused, not ignored', async () => {
    const id = await created(a.exec1);
    const { id: taskId } = await tasks.scheduleFollowUp(a.exec1.ctx, id, { dueAt: local(60) });
    const v = String((await migrator().task.findUniqueOrThrow({ where: { id: taskId } })).version);
    expect(
      await fieldsOf(
        log(a.exec1, id, { followUpTaskId: taskId, followUpVersion: v, rescheduleReason: 'Busy' }),
      ),
    ).toEqual(['rescheduleReason']);
    expect(await fieldsOf(log(a.exec1, id, { nextTitle: 'Call back' }))).toEqual(['nextTitle']);
    expect(
      await fieldsOf(
        log(a.exec1, id, {
          followUpTaskId: taskId,
          followUpVersion: v,
          nextDueAt: local(120),
          nextTitle: 'Call back',
        }),
      ),
    ).toEqual(['nextTitle']);
    expect(await logged(id)).toHaveLength(0);
  });

  it('collects every message instead of overwriting one with another', async () => {
    const id = await created(a.exec1);
    let err: DomainError | null = null;
    try {
      await log(a.exec1, id, {
        followUpTaskId: randomUUID(),
        requirementFields: 'nonsense',
        channel: 'EMAIL',
        durationMinutes: '5',
      });
    } catch (e) {
      err = e as DomainError;
    }
    expect(err?.fieldErrors?._).toHaveLength(2);
    expect(err?.fieldErrors?.durationMinutes).toHaveLength(1);
  });
});

describe('roles, scope and other orgs', () => {
  it('follows interaction.create: O / O / T / S, not HR; other orgs see nothing', async () => {
    const mine = await created(a.exec1);
    const exec2Lead = await created(a.exec2);
    expect(await codeOf(log(a.hr, mine))).toBe('FORBIDDEN');
    expect(await codeOf(log(a.exec2, mine))).toBe('NOT_FOUND');
    expect(await codeOf(log(a.manager, exec2Lead))).toBe('NOT_FOUND'); // not in the West team
    expect(await codeOf(log(ownerB, mine))).toBe('NOT_FOUND');
    expect(await codeOf(log(a.manager, mine, { outcome: 'NO_ANSWER' }))).toBe('OK');
    expect(await codeOf(log(a.admin, exec2Lead, { outcome: 'NO_ANSWER' }))).toBe('OK');
    expect(await codeOf(log(a.owner, exec2Lead, { outcome: 'NO_ANSWER' }))).toBe('OK');
    expect((await logged(mine)).map((x) => x.userId)).toEqual([A.users.manager.id]);
  });

  it('refuses archived leads and garbage ids', async () => {
    const id = await created(a.exec1);
    await leads.archiveLead(a.admin.ctx, id, {
      version: (await row(id)).version,
      reason: 'Synthetic archive',
    });
    expect(await codeOf(log(a.admin, id))).toBe('RULE_VIOLATION');
    expect(
      await codeOf(
        interactions.logInteraction(a.admin.ctx, {
          leadId: 'not-a-uuid',
          idempotencyKey: randomUUID(),
          version: 1,
          channel: 'PHONE_NATIVE',
          direction: 'INBOUND',
          outcome: 'CONNECTED_INTERESTED',
          occurredAt: local(-1),
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(await logged(id)).toHaveLength(0);
  });
});

describe('database guarantees (migration 0017)', () => {
  let leadId: string;
  beforeAll(async () => {
    leadId = await created(a.exec1);
    await log(a.exec1, leadId, { outcome: 'NO_ANSWER' });
  });
  const insert = (userId: string, values: string, params: unknown[] = []) =>
    asApp(
      A.orgId,
      userId,
      `INSERT INTO interaction (org_id, lead_id, user_id, channel, direction, outcome,
         outcome_group, occurred_at, contact_status_at_log, client_idempotency_key, request_fingerprint, logged_at)
       VALUES ${values}`,
      params,
    );

  it('is append-only and stamps the session user and the transaction time', async () => {
    const [ix] = await logged(leadId);
    expect(
      await sqlState(
        asApp(A.orgId, A.users.exec1.id, `UPDATE interaction SET notes = 'x' WHERE id = $1`, [
          ix!.id,
        ]),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        asApp(A.orgId, A.users.exec1.id, `DELETE FROM interaction WHERE id = $1`, [ix!.id]),
      ),
    ).toBe('42501');
    const base = `($1, $2, $3, 'PHONE_NATIVE', 'OUTBOUND', 'NO_ANSWER', 'NOT_CONNECTED', now(),
      'OK', gen_random_uuid(), repeat('a', 64), $4)`;
    // Someone else as the actor, a back-dated log time, an HR session: refused by RLS.
    expect(
      await sqlState(insert(A.users.exec1.id, base, [A.orgId, leadId, A.users.exec2.id, 'now'])),
    ).toBe('42501');
    expect(
      await sqlState(
        insert(A.users.exec1.id, base, [A.orgId, leadId, A.users.exec1.id, '2026-01-01T00:00Z']),
      ),
    ).toBe('42501');
    expect(
      await sqlState(insert(A.users.hr.id, base, [A.orgId, leadId, A.users.hr.id, 'now'])),
    ).toBe('42501');
    // As the session user, now: accepted (the CHECKs and guard still apply).
    expect(
      await sqlState(insert(A.users.exec1.id, base, [A.orgId, leadId, A.users.exec1.id, 'now'])),
    ).toBe('OK');
  });

  it('checks shapes: outcome fit, status match, reported time, source', async () => {
    const v = (outcome: string, group: string, channel: string, occurred: string, status = 'OK') =>
      `($1, $2, $3, '${channel}', 'OUTBOUND', '${outcome}', '${group}', ${occurred}, '${status}',
        gen_random_uuid(), repeat('a', 64), now())`;
    const p = [A.orgId, leadId, A.users.exec1.id];
    expect(
      await sqlState(
        insert(A.users.exec1.id, v('MESSAGE_SENT', 'OTHER', 'PHONE_NATIVE', 'now()'), p),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        insert(A.users.exec1.id, v('NO_ANSWER', 'CONNECTED', 'PHONE_NATIVE', 'now()'), p),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        insert(
          A.users.exec1.id,
          v('NO_ANSWER', 'NOT_CONNECTED', 'PHONE_NATIVE', "now() + interval '1 hour'"),
          p,
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        insert(
          A.users.exec1.id,
          v('NO_ANSWER', 'NOT_CONNECTED', 'PHONE_NATIVE', "now() - interval '8 days'"),
          p,
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        insert(
          A.users.exec1.id,
          v('NO_ANSWER', 'NOT_CONNECTED', 'PHONE_NATIVE', 'now()', 'INVALID'),
          p,
        ),
      ),
    ).toBe('23514'); // the lead is OK: the stored status must be the lead's
    expect(
      await sqlState(
        asApp(
          A.orgId,
          A.users.exec1.id,
          `INSERT INTO interaction (org_id, lead_id, user_id, channel, direction, outcome,
             outcome_group, occurred_at, contact_status_at_log, client_idempotency_key, request_fingerprint, source)
           VALUES ($1, $2, $3, 'PHONE_NATIVE', 'OUTBOUND', 'NO_ANSWER', 'NOT_CONNECTED', now(),
             'OK', gen_random_uuid(), repeat('a', 64), 'PROVIDER')`,
          p,
        ),
      ),
    ).toBe('23514'); // no provider rows in this slice
  });

  it('keeps other orgs out and lets only lead roles and read-only support sessions read', async () => {
    const count = async (orgId: string, userId: string, readOnly = false) =>
      Number(
        (
          await asApp(
            orgId,
            userId,
            `SELECT count(*)::int AS n FROM interaction WHERE lead_id = $1`,
            [leadId],
            readOnly,
          )
        ).rows[0].n,
      );
    expect(await count(A.orgId, A.users.exec1.id)).toBeGreaterThan(0);
    expect(await count(A.orgId, A.users.hr.id)).toBe(0); // HR: no interaction.read
    expect(await count(B.orgId, B.users.owner.id)).toBe(0); // another org
    const staff = randomUUID(); // no membership in A
    expect(await count(A.orgId, staff, true)).toBeGreaterThan(0); // support grant: read-only
    expect(await count(A.orgId, staff, false)).toBe(0);
    // Writing into another org's lead: refused.
    expect(
      await sqlState(
        asApp(
          B.orgId,
          B.users.owner.id,
          `INSERT INTO interaction (org_id, lead_id, user_id, channel, direction, outcome,
             outcome_group, occurred_at, contact_status_at_log, client_idempotency_key,
             request_fingerprint)
           VALUES ($1, $2, $3, 'PHONE_NATIVE', 'INBOUND', 'CONNECTED_INTERESTED', 'CONNECTED',
             now(), 'OK', gen_random_uuid(), repeat('a', 64))`,
          [B.orgId, leadId, B.users.owner.id],
        ),
      ),
    ).not.toBe('OK');
  });
});

describe('script version shown (FR-098, migration 0019)', () => {
  const content = {
    opening: 'Namaste, this is Synthetic Realty.',
    questions: '- Budget?',
    pitch: '',
    closing: '',
    objections: [],
  };
  /** A published script of `admin`'s org; returns its id and the live version's id. */
  async function publishedScript(admin: Actor, name: string) {
    const { id } = await scripts.createScript(admin.ctx, { name });
    await scripts.saveDraft(admin.ctx, id, { ...content, draftVersion: 1 });
    await scripts.publishScript(admin.ctx, id, { draftVersion: 2 });
    return { id, versionId: await liveVersion(id) };
  }
  const liveVersion = async (scriptId: string) =>
    (await migrator().callScript.findUniqueOrThrow({ where: { id: scriptId } })).currentVersionId!;
  const draftVersion = async (scriptId: string) =>
    (
      await migrator().callScriptVersion.findFirstOrThrow({
        where: { scriptId, publishedAt: null },
      })
    ).id;

  it('stores the exact version shown; a newer published version never replaces it', async () => {
    const s = await publishedScript(a.admin, `Synthetic FR-098 ${seq++}`);
    const id = await created(a.exec1);
    await log(a.exec1, id, { scriptVersionId: s.versionId });
    // Version 2 is published afterwards: the interaction keeps pointing at version 1.
    await scripts.saveDraft(a.admin.ctx, s.id, { ...content, opening: 'Changed', draftVersion: 0 });
    const draft2 = await migrator().callScriptVersion.findFirstOrThrow({
      where: { scriptId: s.id, publishedAt: null },
    });
    await scripts.publishScript(a.admin.ctx, s.id, { draftVersion: draft2.version });
    expect(await liveVersion(s.id)).not.toBe(s.versionId);
    const [ix] = await logged(id);
    expect(ix!.scriptVersionId).toBe(s.versionId);
    const v = await migrator().callScriptVersion.findUniqueOrThrow({
      where: { id: ix!.scriptVersionId! },
    });
    expect(v).toMatchObject({ scriptId: s.id, versionNo: 1 });
  });

  it('stores nothing when no script was shown', async () => {
    const id = await created(a.exec1);
    await log(a.exec1, id, { scriptVersionId: '' });
    await log(a.exec1, id, { outcome: 'NO_ANSWER' });
    expect((await logged(id)).map((r) => r.scriptVersionId)).toEqual([null, null]);
  });

  it('refuses a draft, another organisation’s version and an unknown id; nothing is written', async () => {
    const s = await publishedScript(a.admin, `Synthetic FR-098 ${seq++}`);
    await scripts.saveDraft(a.admin.ctx, s.id, { ...content, opening: 'Draft', draftVersion: 0 });
    const draft = await draftVersion(s.id);
    const other = await publishedScript(ownerB, `Synthetic FR-098 B ${seq++}`);
    const id = await created(a.exec1);
    for (const scriptVersionId of [draft, other.versionId, randomUUID()])
      expect(await codeOf(log(a.exec1, id, { scriptVersionId }))).toBe('VALIDATION_FAILED');
    expect(await codeOf(log(a.exec1, id, { scriptVersionId: 'not-a-uuid' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await logged(id)).toHaveLength(0);
    // The database refuses the same, as crm_app: the BEFORE INSERT guard (23514) runs before the
    // (org_id, script_version_id) foreign key, which is the second line against another org.
    const insert = (versionId: string) =>
      sqlState(
        asApp(
          A.orgId,
          A.users.exec1.id,
          `INSERT INTO interaction (org_id, lead_id, user_id, channel, direction, outcome,
             outcome_group, occurred_at, contact_status_at_log, client_idempotency_key,
             request_fingerprint, script_version_id)
           VALUES ($1, $2, $3, 'PHONE_NATIVE', 'OUTBOUND', 'NO_ANSWER', 'NOT_CONNECTED',
             now(), 'OK', gen_random_uuid(), repeat('a', 64), $4)`,
          [A.orgId, id, A.users.exec1.id, versionId],
        ),
      );
    expect(await insert(draft)).toBe('23514');
    expect(await insert(other.versionId)).toBe('23514');
    expect(await insert(s.versionId)).toBe('OK');
  });

  it('keeps a version whose script was archived after it was shown', async () => {
    const s = await publishedScript(a.admin, `Synthetic FR-098 ${seq++}`);
    await scripts.archiveScript(a.admin.ctx, s.id, {
      version: (await migrator().callScript.findUniqueOrThrow({ where: { id: s.id } })).version,
    });
    const id = await created(a.exec1);
    await log(a.exec1, id, { scriptVersionId: s.versionId });
    expect((await logged(id))[0]!.scriptVersionId).toBe(s.versionId);
  });

  it('is part of the retry fingerprint: same version is a duplicate, another is a conflict', async () => {
    const s1 = await publishedScript(a.admin, `Synthetic FR-098 ${seq++}`);
    const s2 = await publishedScript(a.admin, `Synthetic FR-098 ${seq++}`);
    const id = await created(a.exec1);
    const body = {
      idempotencyKey: randomUUID(),
      version: (await row(id)).version,
      outcome: 'NO_ANSWER',
      scriptVersionId: s1.versionId,
    };
    const first = await log(a.exec1, id, body);
    expect((await log(a.exec1, id, body)).duplicate).toBe(true);
    expect((await log(a.exec1, id, body)).interactionId).toBe(first.interactionId);
    expect(await codeOf(log(a.exec1, id, { ...body, scriptVersionId: s2.versionId }))).toBe(
      'CONFLICT',
    );
    expect(await codeOf(log(a.exec1, id, { ...body, scriptVersionId: '' }))).toBe('CONFLICT');
    expect(await logged(id)).toHaveLength(1);
  });

  it('changes nothing about contact rules: DNC inbound is recorded, outbound still refused', async () => {
    const s = await publishedScript(a.admin, `Synthetic FR-098 ${seq++}`);
    const id = await created(a.exec1);
    await dnc(a.exec1, id);
    const before = await row(id);
    const events = (await statusEvents(id)).length;
    await log(a.exec1, id, {
      direction: 'INBOUND',
      outcome: 'CONNECTED_NOT_INTERESTED',
      scriptVersionId: s.versionId,
      version: before.version,
    });
    expect(
      await fieldsOf(log(a.exec1, id, { direction: 'OUTBOUND', scriptVersionId: s.versionId })),
    ).toEqual(['direction']);
    const after = await row(id);
    expect(after.contactStatus).toBe('DO_NOT_CONTACT');
    expect((await statusEvents(id)).length).toBe(events);
    expect((await logged(id)).map((r) => r.scriptVersionId)).toEqual([s.versionId]);
  });

  it('needs the permissions to log an interaction: HR is refused before anything is read', async () => {
    const s = await publishedScript(a.admin, `Synthetic FR-098 ${seq++}`);
    const id = await created(a.exec1);
    // Owners, admins, managers and executives read scripts; the executive records one here.
    expect((await log(a.exec1, id, { scriptVersionId: s.versionId })).duplicate).toBe(false);
    // HR has neither interaction.create nor script.read: refused before anything else.
    expect(await codeOf(log(a.hr, id, { scriptVersionId: s.versionId }))).toBe('FORBIDDEN');
  });
});
