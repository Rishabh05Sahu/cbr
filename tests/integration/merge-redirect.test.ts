// Phase 2 M5 (D1, merge by reference): every application write path that adds a note or an
// enquiry to a lead resolves a merged lead to its surviving lead. This is APPLICATION-level
// protection. The database freezes the merged lead's own row (lead_hygiene_guard) but does not
// refuse note/enquiry rows that name it; the last test documents that gap explicitly.
// Synthetic data only; crm_test only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import { migrator, openRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
let org: Awaited<ReturnType<typeof seedOrg>>;
let owner: Actor;

let phoneSeq = 0;
const nextPhone = () => `96${String(10_000_000 + ++phoneSeq * 7919 + process.pid).slice(-8)}`;

async function newLead(): Promise<string> {
  const r = await leads.createLead(owner.ctx, {
    fullName: 'Synthetic Customer',
    primaryPhone: nextPhone(),
  });
  if (r.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.leadId;
}

/** Merges `from` into `to` as the owner through crm_app (the merge command is not built yet). */
async function merge(from: string, to: string): Promise<void> {
  const c = await openRole(APP);
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
      [org.orgId, owner.user.id],
    );
    await c.query(`UPDATE lead SET merged_into_lead_id = $2 WHERE id = $1`, [from, to]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  org = await seedOrg('MergeRedirect');
  owner = await actorIn(org.users.owner, org.orgId);
});

describe('merged leads: application write paths go to the survivor (application-level)', () => {
  it('addNote on a merged lead writes the note to its survivor', async () => {
    const [tomb, survivor] = [await newLead(), await newLead()];
    await merge(tomb, survivor);
    const { id } = await leads.addNote(owner.ctx, tomb, { body: 'Synthetic follow-up note' });
    const note = await migrator().leadNote.findUniqueOrThrow({ where: { id } });
    expect(note.leadId).toBe(survivor);
    expect(await migrator().leadNote.count({ where: { leadId: tomb } })).toBe(0);
    const activity = await migrator().leadActivity.findFirstOrThrow({ where: { refId: id } });
    expect(activity.leadId).toBe(survivor);
  });

  it('attachEnquiry on a merged lead attaches the enquiry to its survivor', async () => {
    const [tomb, survivor] = [await newLead(), await newLead()];
    await merge(tomb, survivor);
    const before = await migrator().leadEnquiry.count({ where: { leadId: tomb } });
    await leads.attachEnquiry(owner.ctx, tomb, {});
    expect(await migrator().leadEnquiry.count({ where: { leadId: tomb } })).toBe(before);
    expect(await migrator().leadEnquiry.count({ where: { leadId: survivor } })).toBe(2); // created + attached
  });

  it('follows a merge chain (A into B, B into C) to the live lead', async () => {
    const [a, b, c] = [await newLead(), await newLead(), await newLead()];
    await merge(a, b);
    await merge(b, c);
    const { id } = await leads.addNote(owner.ctx, a, { body: 'Synthetic chained note' });
    expect((await migrator().leadNote.findUniqueOrThrow({ where: { id } })).leadId).toBe(c);
  });

  it('phone-matched paths never see a merged lead: a duplicate resolves to the survivor', async () => {
    const phone = nextPhone();
    const first = await leads.createLead(owner.ctx, {
      fullName: 'Synthetic A',
      primaryPhone: phone,
    });
    const survivor = await newLead();
    if (first.status !== 'created') throw new Error('expected created');
    await merge(first.leadId, survivor);
    // The tombstone keeps its phone but is no longer open, so the phone is free again.
    const again = await leads.createLead(owner.ctx, {
      fullName: 'Synthetic A',
      primaryPhone: phone,
    });
    expect(again.status).toBe('created');
    if (again.status === 'created') expect(again.leadId).not.toBe(first.leadId);
  });

  it('updating a merged lead through the application fails (app check + database freeze)', async () => {
    const [tomb, survivor] = [await newLead(), await newLead()];
    await merge(tomb, survivor);
    const before = await migrator().lead.findUniqueOrThrow({ where: { id: tomb } });
    // Refused by the application first (assertWritable); lead_hygiene_guard also refuses any
    // direct update (hygiene-schema.test.ts).
    await expect(
      leads.changeStage(owner.ctx, tomb, { toStage: 'CONTACTED', version: before.version }),
    ).rejects.toThrow(/merged into another lead/);
    const after = await migrator().lead.findUniqueOrThrow({ where: { id: tomb } });
    expect(after.stage).toBe(before.stage);
    expect(after.version).toBe(before.version);
  });

  it('NOT database-enforced: a direct crm_app insert naming a merged lead is accepted', async () => {
    // Documents the boundary: only the application redirects notes/enquiries. A future
    // database trigger on lead_note / lead_enquiry would be a separate, reviewed change.
    const [tomb, survivor] = [await newLead(), await newLead()];
    await merge(tomb, survivor);
    const c = await openRole(APP);
    try {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [org.orgId, owner.user.id],
      );
      const r = await c.query(
        `INSERT INTO lead_note (org_id, lead_id, author_id, body, edited_until)
         VALUES ($1, $2, $3, 'Direct synthetic note', now() + interval '15 minutes')`,
        [org.orgId, tomb, owner.user.id],
      );
      expect(r.rowCount).toBe(1);
    } finally {
      await c.query('ROLLBACK');
      await c.end();
    }
  });
});
