// POST /api/v1/visits/:id/properties — replace the properties an open visit will show (migration
// 0032, owner request 2026-11-24), the same command as the website (setVisitProperties:
// site_visit.manage over the visit's lead, open visit, expected version, at most 10 properties of
// the organisation). Body: { version, propertyIds: string[] }.
import { setVisitProperties } from '@/modules/visits';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('visit-properties', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  const ids = Array.isArray(body.propertyIds)
    ? body.propertyIds.filter((v): v is string => typeof v === 'string')
    : [];
  return setVisitProperties(ctx, params.id, { version: body.version, propertyIds: ids });
});
