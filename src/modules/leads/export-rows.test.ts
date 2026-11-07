// loadExportRows with a stub transaction (no database, no persistent synthetic leads): at the
// 50,000-row boundary exactly the cap is returned and one more is refused, never truncated; and
// both phone columns follow the org's phone masking setting (FR-060).
import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@/platform/authz';
import type { Tx } from '@/platform/db';
import { EXPORT_ROW_CAP, ExportTooLarge } from './export-format';
import { loadExportRows } from './export-rows';
import { maskPhone } from './phone-masking';

const owner = {
  kind: 'member',
  userId: '0199a000-0000-7000-8000-000000000001',
  orgId: '0199a000-0000-7000-8000-000000000002',
  orgName: 'Synthetic Realty',
  membershipId: '0199a000-0000-7000-8000-000000000003',
  role: 'OWNER',
  pluginRole: 'owner',
  tenant: { orgId: '0199a000-0000-7000-8000-000000000002', userId: null },
} as unknown as RequestContext;

function stubTx(rows: number, phoneMasking = false) {
  let take: number | undefined;
  let policyOrg: string | undefined;
  const row = {
    id: 'x',
    fullName: 'Synthetic',
    primaryPhoneE164: '+919000000001',
    alternatePhoneE164: '+919000000002',
    email: null,
    stage: 'NEW',
    transactionType: null,
    propertyType: null,
    bhkMin: null,
    bhkMax: null,
    budgetMin: null,
    budgetMax: null,
    preferredCity: null,
    preferredLocalities: [],
    createdAt: new Date(0),
    archivedAt: null,
    source: { name: 'Website' },
    owner: null,
    team: null,
  };
  const tx = {
    organization: {
      findFirstOrThrow: async () => ({ timeZone: 'Asia/Kolkata' }),
      findUnique: async (args: { where: { id: string } }) => {
        policyOrg = args.where.id;
        return { phoneMasking, phoneRevealDailyCap: 50 };
      },
    },
    lead: {
      findMany: async (args: { take?: number }) => {
        take = args.take;
        return Array.from({ length: Math.min(rows, args.take ?? rows) }, () => row);
      },
    },
  } as unknown as Tx;
  return { tx, take: () => take, policyOrg: () => policyOrg };
}

describe('loadExportRows at the row cap', () => {
  it('returns exactly 50,000 rows', async () => {
    const s = stubTx(EXPORT_ROW_CAP);
    expect(await loadExportRows(s.tx, owner, {})).toHaveLength(EXPORT_ROW_CAP);
    expect(s.take()).toBe(EXPORT_ROW_CAP + 1); // asks for one more to detect overflow
  });

  it('refuses 50,001 rows instead of truncating', async () => {
    await expect(loadExportRows(stubTx(EXPORT_ROW_CAP + 1).tx, owner, {})).rejects.toThrow(
      ExportTooLarge,
    );
  });
});

describe('loadExportRows and phone masking (FR-060)', () => {
  it('masks the primary and alternate phone while masking is on', async () => {
    const s = stubTx(2, true);
    const out = await loadExportRows(s.tx, owner, {});
    expect(s.policyOrg()).toBe(owner.orgId); // the requester's own org setting
    expect(out.map((r) => [r.primaryPhoneE164, r.alternatePhoneE164])).toEqual([
      [maskPhone('+919000000001'), maskPhone('+919000000002')],
      [maskPhone('+919000000001'), maskPhone('+919000000002')],
    ]);
    expect(JSON.stringify(out)).not.toMatch(/9000000001|9000000002/);
  });

  it('keeps the full numbers while masking is off', async () => {
    const [r] = await loadExportRows(stubTx(1, false).tx, owner, {});
    expect(r).toMatchObject({
      primaryPhoneE164: '+919000000001',
      alternatePhoneE164: '+919000000002',
    });
  });
});
