// GET /api/v1/dashboard?period=&team=&user=&source= — the dashboard in the caller's report scope
// (FR-130–133): own figures for executives, their teams for managers, the organisation for
// Owner/Admin. Same numbers as the website.
import { dashboard } from '@/modules/reporting';
import { apiRoute, queryOf } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('dashboard', async ({ req, ctx }) => {
  const q = queryOf(req);
  const d = await dashboard(ctx, {
    period: q.period,
    from: q.from,
    to: q.to,
    team: q.team,
    user: q.user,
    source: q.source,
  });
  // KPI definitions are for the website's drill-down; the app needs only the figures.
  const tile = (t: (typeof d.kpis)[number]) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    unavailable: t.unavailable,
    count: t.count,
    ratio: t.ratio,
    medianAgeHours: t.medianAgeHours ?? null,
  });
  return { ...d, kpis: d.kpis.map(tile), operational: d.operational.map(tile) };
});
