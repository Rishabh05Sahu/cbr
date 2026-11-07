// M6 set-based import prototype: concurrency, crash/rollback and tenant isolation (the
// differential test covers equivalence). Synthetic data only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import { tenantRunner } from '@/platform/db';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let ownerA: Actor;
let adminA: Actor;
let ownerB: Actor;
let sourceA: string;
let sourceB: string;

let seq = 0;
const phone = () => `93${String(40_000_000 + ++seq * 4_441).slice(-8)}`;

function row(n: number, p: string, source: string, extra: Partial<leads.CreateInput> = {}) {
  const prepared = leads.prepareLead(
    leads.createInput.parse({ fullName: `Concurrent ${n}`, primaryPhone: p, ...extra }),
  );
  if (!prepared.ok) throw new Error('bad fixture');
  return { row: n, lead: prepared.lead, sourceId: source };
}
const setOpts = (importId = randomUUID()) => ({
  importId,
  duplicatePolicy: 'ATTACH' as const,
  assignment: { mode: 'none' } as const,
  strategy: 'set' as const,
});
const holders = (orgId: string, p: string) =>
  migrator().lead.count({
    where: { orgId, OR: [{ primaryPhoneE164: `+91${p}` }, { alternatePhoneE164: `+91${p}` }] },
  });

beforeAll(async () => {
  A = await seedOrg('ImportSetA');
  B = await seedOrg('ImportSetB');
  ownerA = await actorIn(A.users.owner, A.orgId);
  adminA = await actorIn(A.users.admin, A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  sourceA = (
    await migrator().leadSource.create({
      data: { orgId: A.orgId, name: 'Portal', channel: 'PORTAL' },
    })
  ).id;
  sourceB = (
    await migrator().leadSource.create({
      data: { orgId: B.orgId, name: 'Portal', channel: 'PORTAL' },
    })
  ).id;
});

describe('set-based import: concurrency', () => {
  it('two imports of the same 30 phones in opposite orders: one lead per phone, no deadlock', async () => {
    const phones = Array.from({ length: 30 }, () => phone());
    const forward = phones.map((p, i) => row(i + 2, p, sourceA));
    const backward = [...phones].reverse().map((p, i) => row(i + 2, p, sourceA));
    const [x, y] = await Promise.all([
      leads.importLeadBatch(ownerA.ctx, forward, setOpts()),
      leads.importLeadBatch(adminA.ctx, backward, setOpts()),
    ]);
    const all = [...x, ...y];
    expect(all.filter((o) => o.outcome === 'CREATED')).toHaveLength(30);
    expect(all.filter((o) => o.outcome === 'ATTACHED')).toHaveLength(30);
    for (const p of phones) expect(await holders(A.orgId, p)).toBe(1);
  });

  it('the same e-mails in opposite orders in two concurrent imports: no deadlock, cases opened', async () => {
    const emails = Array.from({ length: 15 }, (_, i) => `race.${i}.${randomUUID()}@example.test`);
    const mk = (list: string[]) => list.map((e, i) => row(i + 2, phone(), sourceA, { email: e }));
    const [x, y] = await Promise.all([
      leads.importLeadBatch(ownerA.ctx, mk(emails), setOpts()),
      leads.importLeadBatch(adminA.ctx, mk([...emails].reverse()), setOpts()),
    ]);
    expect([...x, ...y].every((o) => o.outcome === 'CREATED')).toBe(true);
    const cases = await migrator().leadDuplicateMatch.count({
      where: { orgId: A.orgId, matchType: 'EMAIL', lead: { email: { in: emails } } },
    });
    expect(cases).toBe(15); // one pair per e-mail, whichever import committed second
  });

  it('a manual create racing an import for the same phone: exactly one lead', async () => {
    const p = phone();
    const [imp, manual] = await Promise.all([
      leads.importLeadBatch(ownerA.ctx, [row(2, p, sourceA)], setOpts()),
      leads.createLead(adminA.ctx, { fullName: 'Manual racer', primaryPhone: p }),
    ]);
    expect(await holders(A.orgId, p)).toBe(1);
    expect([imp[0]!.outcome, manual.status].sort()).toEqual(
      imp[0]!.outcome === 'CREATED' ? ['CREATED', 'duplicate'] : ['ATTACHED', 'created'],
    );
  });
});

describe('set-based import: crash inside the batch transaction', () => {
  it('a failure after the writes rolls everything back; the retry writes the batch once', async () => {
    const importId = randomUUID();
    const batch = [2, 3, 4].map((n) => row(n, phone(), sourceA, { note: `note ${n}` }));
    const before = await migrator().lead.count({ where: { orgId: A.orgId } });
    await expect(
      tenantRunner().withTenant(ownerA.ctx.tenant, async (tx) => {
        await leads.commitImportBatch(tx, ownerA.ctx, batch, setOpts(importId));
        throw new Error('simulated worker crash');
      }),
    ).rejects.toThrow('simulated worker crash');
    expect(await migrator().lead.count({ where: { orgId: A.orgId } })).toBe(before);
    expect(
      await migrator().leadEnquiry.count({ where: { externalId: { startsWith: importId } } }),
    ).toBe(0);
    const retry = await leads.importLeadBatch(ownerA.ctx, batch, setOpts(importId));
    expect(retry.map((o) => o.outcome)).toEqual(['CREATED', 'CREATED', 'CREATED']);
    const again = await leads.importLeadBatch(ownerA.ctx, batch, setOpts(importId));
    expect(again.map((o) => o.outcome)).toEqual([
      'ALREADY_IMPORTED',
      'ALREADY_IMPORTED',
      'ALREADY_IMPORTED',
    ]);
    expect(await migrator().lead.count({ where: { orgId: A.orgId } })).toBe(before + 3);
    expect(await migrator().leadNote.count({ where: { orgId: A.orgId, body: 'note 2' } })).toBe(1);
  });
});

describe('set-based import: tenant isolation', () => {
  it("another org's open lead, closed lead and e-mail never match; each org writes only its own rows", async () => {
    const p = phone();
    const closed = phone();
    const email = `iso.${randomUUID()}@example.test`;
    await leads.importLeadBatch(ownerA.ctx, [row(2, p, sourceA, { email })], setOpts());
    await migrator().lead.create({
      data: {
        orgId: A.orgId,
        fullName: 'A closed',
        primaryPhoneE164: `+91${closed}`,
        primaryPhoneRaw: closed,
        phoneLast10: closed,
        sourceId: sourceA,
        stage: 'LOST',
        lostAt: new Date(),
      },
    });
    const out = await leads.importLeadBatch(
      ownerB.ctx,
      [row(2, p, sourceB, { email }), row(3, closed, sourceB)],
      setOpts(),
    );
    expect(out.map((o) => o.outcome)).toEqual(['CREATED', 'CREATED']);
    const bLeads = await migrator().lead.findMany({
      where: { id: { in: out.map((o) => o.leadId!) } },
    });
    expect(bLeads.every((l) => l.orgId === B.orgId && l.previousLeadId === null)).toBe(true);
    expect(
      await migrator().leadDuplicateMatch.count({
        where: { OR: [{ leadId: { in: out.map((o) => o.leadId!) } }] },
      }),
    ).toBe(0);
  });

  it('a source of another org is refused (RLS hides it), so nothing is written', async () => {
    await expect(
      leads.importLeadBatch(ownerB.ctx, [row(2, phone(), sourceA)], setOpts()),
    ).rejects.toThrow(/source/i);
  });
});
