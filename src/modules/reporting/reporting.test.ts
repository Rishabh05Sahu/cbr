import { describe, expect, it } from 'vitest';
import { KPIS, kpiById, LOW_SAMPLE, percent, ratio } from './definitions';
import { MAX_CUSTOM_DAYS, resolvePeriod } from './periods';
import { BUILDERS, byUserSql, listSql, tileSql, type Frame } from './queries';

describe('report periods (metrics §1.2, org-local days, half-open)', () => {
  // 2026-10-30 is a Friday.
  const today = '2026-10-30';
  it('today and yesterday', () => {
    expect(resolvePeriod('today', today)).toEqual({
      kind: 'today',
      first: today,
      end: '2026-10-31',
    });
    expect(resolvePeriod('yesterday', today)).toEqual({
      kind: 'yesterday',
      first: '2026-10-29',
      end: today,
    });
  });
  it('weeks run Monday to Sunday', () => {
    expect(resolvePeriod('this_week', today)).toMatchObject({
      first: '2026-10-26',
      end: '2026-11-02',
    });
    expect(resolvePeriod('last_week', today)).toMatchObject({
      first: '2026-10-19',
      end: '2026-10-26',
    });
    // A Sunday belongs to the week that started the Monday before; a Monday starts its own.
    expect(resolvePeriod('this_week', '2026-11-01')).toMatchObject({ first: '2026-10-26' });
    expect(resolvePeriod('this_week', '2026-11-02')).toMatchObject({ first: '2026-11-02' });
  });
  it('months, including year boundaries and short months', () => {
    expect(resolvePeriod('this_month', today)).toMatchObject({
      first: '2026-10-01',
      end: '2026-11-01',
    });
    expect(resolvePeriod('last_month', '2026-01-15')).toMatchObject({
      first: '2025-12-01',
      end: '2026-01-01',
    });
    expect(resolvePeriod('this_month', '2028-02-29')).toMatchObject({ end: '2028-03-01' });
  });
  it('custom: inclusive dates, ordered, at most 366 days', () => {
    expect(resolvePeriod('custom', today, { from: '2026-01-01', to: '2026-01-31' })).toEqual({
      kind: 'custom',
      first: '2026-01-01',
      end: '2026-02-01',
    });
    expect(resolvePeriod('custom', today, { from: '2025-01-01', to: '2026-01-01' })).toMatchObject({
      first: '2025-01-01',
    }); // 366 days
    expect(resolvePeriod('custom', today, { from: '2025-01-01', to: '2026-01-02' })).toEqual({
      error: `A custom range covers at most ${MAX_CUSTOM_DAYS} days`,
    });
    expect(resolvePeriod('custom', today, { from: '2026-02-01', to: '2026-01-01' })).toHaveProperty(
      'error',
    );
    expect(resolvePeriod('custom', today, { from: '2026-02-30', to: '2026-03-01' })).toHaveProperty(
      'error',
    );
    expect(resolvePeriod('custom', today, {})).toHaveProperty('error');
  });
  it('anything else is this month', () => {
    expect(resolvePeriod(undefined, today)).toMatchObject({ kind: 'this_month' });
    expect(resolvePeriod('decade', today)).toMatchObject({ kind: 'this_month' });
  });
});

describe('KPI catalogue', () => {
  it('covers K01–K13 and K18–K20, and nothing outside Phase 4', () => {
    const codes = new Set(KPIS.map((k) => k.code));
    for (const c of ['K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07', 'K08', 'K08b', 'K09', 'K09b'])
      expect(codes).toContain(c);
    for (const c of ['K10', 'K11', 'K12', 'K12b', 'K13', 'K18', 'K19', 'K19b', 'K20'])
      expect(codes).toContain(c);
    for (const c of ['K14', 'K15', 'K16', 'K17', 'K21', 'K22', 'K23', 'K24'])
      expect(codes).not.toContain(c);
  });
  it('marks exactly the KPIs without an honest source as unavailable', () => {
    expect(KPIS.filter((k) => k.unavailable).map((k) => k.id)).toEqual([
      'k06',
      'k07-provider',
      'k08-provider',
      'k09b',
      'k12b',
      'k19',
    ]);
    expect(kpiById('k06')!.unavailable).toMatch(/provider/);
    expect(kpiById('k19')!.unavailable).toMatch(/leave/);
    expect(kpiById('k12b')!.unavailable).toMatch(/who cancelled/);
  });
  it('every available KPI has a shared query definition (tile = drill-down)', () => {
    for (const k of KPIS.filter((d) => !d.unavailable))
      expect(BUILDERS[k.id], k.id).toBeTypeOf('function');
  });
  it('ratios: low sample below 20, "—" for an empty denominator, never a fabricated zero', () => {
    expect(ratio(3, LOW_SAMPLE - 1).lowSample).toBe(true);
    expect(ratio(3, LOW_SAMPLE).lowSample).toBe(false);
    expect(percent(ratio(0, 0))).toBe('—');
    expect(percent(ratio(1, 3))).toBe('33%');
  });
});

describe('query definitions', () => {
  const base: Frame = {
    orgId: '00000000-0000-4000-8000-000000000001',
    scope: 'ORG',
    me: '00000000-0000-4000-8000-000000000002',
    ledTeamIds: [],
    teamMemberIds: [],
    from: new Date('2026-09-30T18:30:00Z'),
    to: new Date('2026-10-31T18:30:00Z'),
    now: new Date('2026-10-30T10:00:00Z'),
    todayFrom: new Date('2026-10-29T18:30:00Z'),
    todayTo: new Date('2026-10-30T18:30:00Z'),
    teamId: null,
    userId: null,
    sourceId: null,
  };
  const frames: Frame[] = [
    base,
    { ...base, scope: 'OWN' },
    { ...base, scope: 'TEAM', ledTeamIds: [base.orgId], teamMemberIds: [base.me] },
    { ...base, teamId: base.orgId, userId: base.me, sourceId: base.orgId },
    { ...base, perUser: true },
  ];
  // Postgres refuses a statement with a parameter it never uses, and a placeholder without a value.
  it('binds every value it uses and uses every value it binds', () => {
    for (const id of Object.keys(BUILDERS))
      for (const f of frames)
        for (const { text, values } of [
          tileSql(id, f),
          byUserSql(id, f),
          listSql(id, f, { limit: 10, offset: 0 }),
        ]) {
          const used = new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
          expect(
            [...used].sort((a, b) => a - b),
            id,
          ).toEqual(values.map((_, i) => i + 1));
        }
  });
  it('never writes a filter value into the SQL text', () => {
    const f = { ...base, userId: "x'; DROP TABLE lead; --" };
    expect(tileSql('k05', f).text).not.toContain('DROP');
  });
  it('the organisation view of K02 counts distinct leads; per person it counts spells', () => {
    expect(tileSql('k02', base).text).toContain('DISTINCT ON (lead_id)');
    expect(tileSql('k02', { ...base, perUser: true }).text).not.toContain('DISTINCT ON');
    expect(tileSql('k02', { ...base, scope: 'OWN' }).text).not.toContain('DISTINCT ON');
  });
  it('the organisation cohort enters on lead creation; personal cohorts on assignment spells', () => {
    expect(tileSql('k13', base).text).toContain('l.created_at AS at');
    expect(tileSql('k13', { ...base, scope: 'TEAM' }).text).toContain('lead_assignment_history s');
  });
});
