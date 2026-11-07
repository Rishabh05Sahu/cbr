// M6 set-based import prototype (docs/PHASE-2-M6-SET-BASED-IMPORT.md): DIFFERENTIAL test. Twin
// organisations get the same existing leads, custom fields and team; the same batches are then
// committed with strategy 'row' in one and 'set' in the other. Every outcome and every row
// written (leads, enquiries, stage history, spells, activities, notes, duplicate cases, outbox
// events, round-robin state) must be identical once ids are replaced by stable labels.
// Synthetic data only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as teams from '@/modules/teams';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

type Strategy = 'row' | 'set';
interface Twin {
  strategy: Strategy;
  org: Awaited<ReturnType<typeof seedOrg>>;
  owner: Actor;
  source: string;
  team: string;
  importId: string;
}
const twins: Record<Strategy, Twin> = {} as Record<Strategy, Twin>;

const P = (n: number) => `97${String(55_000_000 + n).slice(-8)}`; // fixed phones, per org
const day = 86_400_000;

async function existingLead(
  t: Twin,
  name: string,
  primary: string,
  o: {
    alternate?: string;
    email?: string;
    stage?: 'NEW' | 'WON' | 'LOST';
    archived?: boolean;
    ageDays?: number;
  } = {},
) {
  const stage = o.stage ?? 'NEW';
  await migrator().lead.create({
    data: {
      orgId: t.org.orgId,
      fullName: name,
      primaryPhoneE164: `+91${primary}`,
      primaryPhoneRaw: primary,
      phoneLast10: primary,
      alternatePhoneE164: o.alternate ? `+91${o.alternate}` : null,
      email: o.email ?? null,
      sourceId: t.source,
      stage,
      ...(stage === 'WON' ? { wonAt: new Date() } : {}),
      ...(stage === 'LOST' ? { lostAt: new Date() } : {}),
      ...(o.archived ? { archivedAt: new Date() } : {}),
      createdAt: new Date(Date.now() - (o.ageDays ?? 30) * day),
    },
  });
}

function row(
  t: Twin,
  n: number,
  input: Partial<leads.CreateInput> & { primaryPhone: string },
  customFields?: Record<string, unknown>,
): leads.ImportRowInput {
  const prepared = leads.prepareLead(
    leads.createInput.parse({ fullName: `Imported ${n}`, ...input }),
  );
  if (!prepared.ok) throw new Error(`bad fixture row ${n}`);
  return {
    row: n,
    lead: prepared.lead,
    sourceId: t.source,
    ...(customFields ? { customFields } : {}),
  };
}

/** Runs the same batch in both twins, with each twin's own strategy. */
async function both(
  build: (t: Twin) => leads.ImportRowInput[],
  extra: (t: Twin) => Partial<leads.ImportBatchOptions> = () => ({}),
) {
  const out = {} as Record<Strategy, leads.ImportRowOutcome[]>;
  for (const s of ['row', 'set'] as const) {
    const t = twins[s];
    out[s] = await leads.importLeadBatch(t.owner.ctx, build(t), {
      importId: t.importId,
      duplicatePolicy: 'ATTACH',
      assignment: { mode: 'none' },
      strategy: s,
      ...extra(t),
    });
  }
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** id → stable label, for everything a twin's rows can point at. */
async function labels(t: Twin): Promise<Map<string, string>> {
  const m = new Map<string, string>([
    [t.org.orgId, 'ORG'],
    [t.importId, 'IMPORT'],
  ]);
  for (const [k, u] of Object.entries(t.org.users)) m.set(u.id, `user:${k}`);
  for (const [k, id] of Object.entries(t.org.membership)) m.set(id, `member:${k}`);
  m.set(t.team, 'team:north');
  for (const s of await migrator().leadSource.findMany({ where: { orgId: t.org.orgId } }))
    m.set(s.id, `source:${s.name}`);
  for (const l of await migrator().lead.findMany({ where: { orgId: t.org.orgId } }))
    m.set(l.id, `lead:${l.fullName}|${l.primaryPhoneE164}`);
  for (const e of await migrator().leadEnquiry.findMany({ where: { orgId: t.org.orgId } }))
    m.set(e.id, `enquiry:${m.get(e.leadId)}|${e.externalId?.split(':')[1] ?? 'first'}`);
  for (const n of await migrator().leadNote.findMany({ where: { orgId: t.org.orgId } }))
    m.set(n.id, `note:${m.get(n.leadId)}`);
  return m;
}

/** Everything the twin wrote, ids replaced by labels, timestamps dropped, sorted. */
async function snapshot(t: Twin) {
  const m = await labels(t);
  const org = { orgId: t.org.orgId };
  const DROP = new Set([
    'id',
    'createdAt',
    'updatedAt',
    'occurredAt',
    'startedAt',
    'receivedAt',
    'editedUntil',
    'wonAt',
    'lostAt',
    'archivedAt',
    'claimedUntil',
  ]);
  const norm = (rows: object[]) =>
    rows
      .map((r) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(r)
              .filter(([k]) => !DROP.has(k))
              .map(([k, v]) => [k, v instanceof Date ? 'date' : v]),
          ),
          (_, v) => (typeof v === 'string' ? v.replace(UUID, (id) => m.get(id) ?? 'UNKNOWN') : v),
        ),
      )
      .sort();
  const db = migrator();
  return {
    leads: norm(
      (await db.lead.findMany({ where: org })).map((l) => ({
        ...l,
        archived: l.archivedAt !== null,
        budgetMin: l.budgetMin?.toString() ?? null,
        budgetMax: l.budgetMax?.toString() ?? null,
      })),
    ),
    enquiries: norm(await db.leadEnquiry.findMany({ where: org })),
    stageHistory: norm(await db.leadStageHistory.findMany({ where: org })),
    spells: norm(await db.leadAssignmentHistory.findMany({ where: org })),
    activities: norm(await db.leadActivity.findMany({ where: org })),
    notes: norm(await db.leadNote.findMany({ where: org })),
    duplicates: norm(
      (await db.leadDuplicateMatch.findMany({ where: org })).map((d) => ({
        ...d,
        score: d.score.toString(),
      })),
    ),
    outbox: norm(
      (await db.outboxEvent.findMany({ where: org })).map(({ publishedAt, attempts, ...e }) => {
        void publishedAt;
        void attempts;
        return e;
      }),
    ),
    roundRobin: norm(await db.teamAssignmentState.findMany({ where: org })),
    labelsUnknown: [] as string[],
  };
}

/** Outcomes with lead ids as labels. */
async function outcomes(t: Twin, os: leads.ImportRowOutcome[]) {
  const m = await labels(t);
  return os.map((o) => ({ ...o, leadId: o.leadId ? (m.get(o.leadId) ?? 'UNKNOWN') : null }));
}

async function expectSame(out: Record<Strategy, leads.ImportRowOutcome[]>) {
  expect(await outcomes(twins.set, out.set)).toEqual(await outcomes(twins.row, out.row));
}

beforeAll(async () => {
  for (const s of ['row', 'set'] as const) {
    const org = await seedOrg(`ImportTwin-${s}`);
    const owner = await actorIn(org.users.owner, org.orgId);
    const team = (await teams.createTeam(owner.ctx, { name: 'North' })).id;
    for (const k of ['manager', 'exec1', 'exec2'] as const)
      await teams.addTeamMember(owner.ctx, {
        teamId: team,
        membershipId: org.membership[k]!,
        teamRole: 'MEMBER',
      });
    const source = (
      await migrator().leadSource.create({
        data: { orgId: org.orgId, name: 'Portal', channel: 'PORTAL' },
      })
    ).id;
    const t: Twin = { strategy: s, org, owner, source, team, importId: randomUUID() };
    twins[s] = t;
    await leads.createCustomField(owner.ctx, { key: 'score', label: 'Score', type: 'number' });
    // Existing leads (identical in both twins).
    await existingLead(t, 'Open One', P(1), { email: 'shared@example.test', ageDays: 50 });
    await existingLead(t, 'Open Two', P(2), { alternate: P(3), ageDays: 40 });
    await existingLead(t, 'Archived Three', P(4), { archived: true, ageDays: 35 });
    await existingLead(t, 'Lost Five', P(5), { stage: 'LOST', ageDays: 300 });
    await existingLead(t, 'Won Five', P(5), { stage: 'WON', ageDays: 100 });
    await existingLead(t, 'Older Alt', P(6), { alternate: P(7), ageDays: 90 });
    await existingLead(t, 'Newer Primary', P(7), { ageDays: 10 });
    for (let i = 0; i < 12; i++)
      await existingLead(t, `Many ${i}`, P(100 + i), {
        email: 'many@example.test',
        ageDays: 200 - i,
      });
  }
});

describe('set-based import commit = row-by-row commit', () => {
  it('a mixed ATTACH batch: new, attached (primary, alternate, archived), returning, e-mail cases, in-batch matches, notes, custom fields', async () => {
    const out = await both((t) => [
      row(t, 2, { primaryPhone: P(10), email: 'Shared@Example.test' }),
      row(t, 3, { primaryPhone: P(1), campaign: 'Diwali' }),
      row(t, 4, { primaryPhone: P(3) }),
      row(t, 5, { primaryPhone: P(4) }),
      row(t, 6, { primaryPhone: P(5) }),
      row(t, 7, { primaryPhone: P(11), alternatePhone: P(10) }), // matches row 2's new lead
      row(t, 8, { primaryPhone: P(12), email: 'many@EXAMPLE.test' }), // 12 candidates → 10
      row(t, 9, { primaryPhone: P(13), email: 'shared@example.test' }), // Open One + row 2
      row(t, 10, { primaryPhone: P(14), note: 'Called back, wants 3BHK' }),
      row(t, 11, {
        primaryPhone: P(15),
        budgetMin: '85 L',
        budgetMax: '1.2 Cr',
        bhkMin: 2,
        bhkMax: 3,
        preferredLocalities: 'Baner, Wakad',
        preferredCity: 'Pune',
        transactionType: 'BUY',
      }),
      row(t, 12, { primaryPhone: P(16) }, { score: 'not a number' }), // FAILED invalid
      row(t, 13, { primaryPhone: P(17) }, { score: 7 }),
      row(t, 14, { primaryPhone: P(7) }), // Older Alt (alternate, older) beats Newer Primary
      row(t, 15, { primaryPhone: P(18), email: 'shared@example.test' }), // + rows 2 and 9
    ]);
    expect(out.row.map((o) => o.outcome)).toEqual([
      'CREATED',
      'ATTACHED',
      'ATTACHED',
      'ATTACHED',
      'CREATED',
      'ATTACHED',
      'CREATED',
      'CREATED',
      'CREATED',
      'CREATED',
      'FAILED',
      'CREATED',
      'ATTACHED',
      'CREATED',
    ]);
    await expectSame(out);
  });

  it('re-running the same batch reports ALREADY_IMPORTED and writes nothing', async () => {
    const out = await both((t) => [
      row(t, 2, { primaryPhone: P(10), email: 'Shared@Example.test' }),
      row(t, 3, { primaryPhone: P(1), campaign: 'Diwali' }),
      row(t, 6, { primaryPhone: P(5) }),
    ]);
    expect(out.row.map((o) => o.outcome)).toEqual([
      'ALREADY_IMPORTED',
      'ALREADY_IMPORTED',
      'ALREADY_IMPORTED',
    ]);
    await expectSame(out);
  });

  it('SKIP policy, including a row that matches a lead created earlier in the batch', async () => {
    const out = await both(
      (t) => [
        row(t, 20, { primaryPhone: P(1) }),
        row(t, 21, { primaryPhone: P(20) }),
        row(t, 22, { primaryPhone: P(21), alternatePhone: P(20) }),
      ],
      () => ({ duplicatePolicy: 'SKIP' }),
    );
    expect(out.row.map((o) => o.outcome)).toEqual([
      'SKIPPED_DUPLICATE',
      'CREATED',
      'SKIPPED_DUPLICATE',
    ]);
    await expectSame(out);
  });

  it('round-robin and target assignment: same owners, spells, stages and digests', async () => {
    const rr = await both(
      (t) => [30, 31, 32, 33, 34].map((n) => row(t, n, { primaryPhone: P(n) })),
      (t) => ({ assignment: { mode: 'round_robin', teamId: t.team } }),
    );
    await expectSame(rr);
    const target = await both(
      (t) => [40, 41].map((n) => row(t, n, { primaryPhone: P(n) })),
      (t) => ({ assignment: { mode: 'target', target: `user:${t.org.users.exec2.id}` } }),
    );
    await expectSame(target);
  });

  it('a required custom field: rows without it fail with the same code, rows with it are created', async () => {
    for (const s of ['row', 'set'] as const)
      await leads.createCustomField(twins[s].owner.ctx, {
        key: 'region',
        label: 'Region',
        type: 'text',
        required: true,
      });
    const out = await both((t) => [
      row(t, 50, { primaryPhone: P(50) }),
      row(t, 51, { primaryPhone: P(51) }, { region: 'West' }),
      row(t, 52, { primaryPhone: P(1) }), // attaching needs no custom values
    ]);
    expect(out.row).toMatchObject([
      { outcome: 'FAILED', field: 'CF_region', code: 'CUSTOM_FIELD_REQUIRED' },
      { outcome: 'CREATED' },
      { outcome: 'ATTACHED' },
    ]);
    await expectSame(out);
  });

  it('everything both twins wrote is identical (labels instead of ids)', async () => {
    const [r, s] = [await snapshot(twins.row), await snapshot(twins.set)];
    for (const k of Object.keys(r) as (keyof typeof r)[]) expect(s[k], k).toEqual(r[k]);
    // The comparison covered real rows, and every id resolved to a label.
    expect(r.leads.length).toBeGreaterThan(30);
    expect(r.duplicates.length).toBeGreaterThan(10);
    expect(JSON.stringify(r)).not.toContain('UNKNOWN');
  });
});
