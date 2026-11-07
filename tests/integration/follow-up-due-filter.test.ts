// FR-056 "follow-up due" filter on the lead list (Phase 3 slice 3): the three approved buckets on
// lead.next_follow_up_at at their boundaries, leads without (or with only closed) follow-ups,
// composition with search and other filters, pagination, role scope, other orgs and invalid
// input. Follow-ups are inserted with exact due times by the schema owner. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import { followUpDueRange } from '@/modules/leads/list-where';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

type Org = Awaited<ReturnType<typeof seedOrg>>;
let A: Org;
let B: Org;
const a = {} as Record<'owner' | 'admin' | 'exec1' | 'exec2', Actor>;
let ownerB: Actor;

let seq = 0;
const phone = () => `91${String(50_000_000 + ++seq * 5_303 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor, name: string): Promise<string> {
  const r = await leads.createLead(by.ctx, { fullName: name, primaryPhone: phone() });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
/** A follow-up with an exact due time (and status), assigned to the lead's creator. */
async function followUp(org: Org, by: Actor, leadId: string, dueAt: Date, done = false) {
  await migrator().task.create({
    data: {
      orgId: org.orgId,
      leadId,
      assigneeUserId: by.user.id,
      createdBy: by.user.id,
      dueAt,
      ...(done ? { status: 'DONE', completedAt: new Date() } : {}),
    },
  });
}
const ids = async (by: Actor, params: Record<string, string | string[]>) =>
  (await leads.searchLeads(by.ctx, params)).rows.map((r) => r.id).sort();

const IST = 'Asia/Kolkata';
const L = {} as Record<
  'overdue' | 'today' | 'tomorrow' | 'lastDay' | 'beyond' | 'none' | 'closed' | 'mixed',
  string
>;

beforeAll(async () => {
  A = await seedOrg('DueA');
  B = await seedOrg('DueB');
  for (const k of ['owner', 'admin', 'exec1', 'exec2'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);

  const now = new Date();
  const today = followUpDueRange('today', IST, now) as { lt: Date };
  const next7 = followUpDueRange('next7', IST, now) as { gte: Date; lt: Date };
  const tomorrow = today.lt;
  const laterToday = new Date(now.getTime() + (tomorrow.getTime() - now.getTime()) / 2);
  for (const k of Object.keys({
    overdue: 1,
    today: 1,
    tomorrow: 1,
    lastDay: 1,
    beyond: 1,
    none: 1,
    closed: 1,
    mixed: 1,
  }) as (keyof typeof L)[])
    L[k] = await created(a.exec1, `Due Synth ${k}`);
  await followUp(A, a.exec1, L.overdue, new Date(now.getTime() - 2 * 3_600_000));
  await followUp(A, a.exec1, L.today, laterToday);
  await followUp(A, a.exec1, L.tomorrow, tomorrow); // exactly the next local midnight
  await followUp(A, a.exec1, L.lastDay, new Date(next7.lt.getTime() - 60_000));
  await followUp(A, a.exec1, L.beyond, next7.lt); // exactly 8 local days ahead: outside
  await followUp(A, a.exec1, L.closed, new Date(now.getTime() - 3_600_000), true);
  await followUp(A, a.exec1, L.mixed, new Date(now.getTime() - 3_600_000), true);
  await followUp(A, a.exec1, L.mixed, new Date(tomorrow.getTime() + 3 * 3_600_000));
});

describe('follow-up due buckets (FR-056)', () => {
  const q = 'Due Synth';
  it('overdue: next open follow-up before now', async () => {
    expect(await ids(a.exec1, { q, due: 'overdue' })).toEqual([L.overdue]);
  });
  it('due today: from now to the next local midnight', async () => {
    expect(await ids(a.exec1, { q, due: 'today' })).toEqual([L.today]);
  });
  it('next 7 days: from the next local midnight, for seven days, end excluded', async () => {
    expect(await ids(a.exec1, { q, due: 'next7' })).toEqual(
      [L.tomorrow, L.lastDay, L.mixed].sort(),
    );
  });
  it('never matches leads without an open follow-up (none, or closed ones only)', async () => {
    const matched = new Set(
      (
        await Promise.all(['overdue', 'today', 'next7'].map((due) => ids(a.exec1, { q, due })))
      ).flat(),
    );
    for (const k of ['none', 'closed', 'beyond'] as const) expect(matched.has(L[k])).toBe(false);
    expect(await ids(a.exec1, { q })).toHaveLength(8); // without the filter every lead lists
  });
  it('a lead leaves the buckets when it is lost (its follow-ups are cancelled)', async () => {
    const lost = await created(a.exec1, 'Due Synth lost');
    await followUp(A, a.exec1, lost, new Date(Date.now() - 600_000));
    expect(await ids(a.exec1, { q: 'Due Synth lost', due: 'overdue' })).toEqual([lost]);
    const v = (await migrator().lead.findUniqueOrThrow({ where: { id: lost } })).version;
    await leads.changeStage(a.exec1.ctx, lost, {
      toStage: 'LOST',
      version: String(v),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(await ids(a.exec1, { q: 'Due Synth lost', due: 'overdue', archived: 'all' })).toEqual(
      [],
    );
  });
});

describe('composition, pagination and invalid input', () => {
  it('combines with stage and search filters', async () => {
    const v = (await migrator().lead.findUniqueOrThrow({ where: { id: L.lastDay } })).version;
    await leads.changeStage(a.exec1.ctx, L.lastDay, { toStage: 'CONTACTED', version: String(v) });
    expect(await ids(a.exec1, { q: 'Due Synth', due: 'next7', stage: 'CONTACTED' })).toEqual([
      L.lastDay,
    ]);
    expect(await ids(a.exec1, { q: 'Due Synth tomorrow', due: 'next7' })).toEqual([L.tomorrow]);
    expect(await ids(a.exec1, { q: 'Due Synth tomorrow', due: 'today' })).toEqual([]);
  });

  it('pages with the cursor without gaps or repeats', async () => {
    const made: string[] = [];
    const soon = followUpDueRange('next7', IST, new Date()) as { gte: Date };
    for (let i = 0; i < 27; i++) {
      const id = await created(a.admin, `Due Page ${i}`);
      await followUp(A, a.admin, id, new Date(soon.gte.getTime() + i * 60_000));
      made.push(id);
    }
    const first = await leads.searchLeads(a.admin.ctx, { q: 'Due Page', due: 'next7' });
    expect(first.rows).toHaveLength(leads.LEAD_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    const second = await leads.searchLeads(a.admin.ctx, {
      q: 'Due Page',
      due: 'next7',
      cursor: first.nextCursor!,
    });
    expect(second.nextCursor).toBeNull();
    const all = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(27);
    expect(all.sort()).toEqual(made.sort());
  });

  it('refuses an unknown option and runs no query', async () => {
    const page = await leads.searchLeads(a.exec1.ctx, { due: 'tomorrow' });
    expect(page.errors).toEqual({ due: 'Unknown follow-up due option' });
    expect(page.rows).toEqual([]);
  });
});

describe('scope and isolation', () => {
  it('keeps the filter inside each role’s lead scope and the org', async () => {
    const execTwos = await created(a.exec2, 'Due Scope two');
    await followUp(A, a.exec2, execTwos, new Date(Date.now() - 3_600_000));
    const bLead = await created(ownerB, 'Due Scope b');
    await followUp(B, ownerB, bLead, new Date(Date.now() - 3_600_000));

    expect(await ids(a.exec2, { due: 'overdue' })).toEqual([execTwos]);
    expect(await ids(a.exec1, { due: 'overdue' })).not.toContain(execTwos);
    const ownerSees = await ids(a.owner, { due: 'overdue' });
    expect(ownerSees).toContain(execTwos);
    expect(ownerSees).toContain(L.overdue);
    expect(ownerSees).not.toContain(bLead);
    expect(await ids(ownerB, { due: 'overdue' })).toEqual([bLead]);
  });
});
