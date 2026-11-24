// POST /api/v1/leads/:id/visits — book a site visit from the app (FR-150), the same command as the
// website's Schedule visit form (scheduleVisit: site_visit.manage over the lead, an open writable
// lead that is not Do-Not-Contact, a future time, a meeting point and, for managers, a salesperson
// they may assign). Body: { scheduledFor, location, assigneeUserId?, propertyIds? } (properties to
// show, migration 0032). Answers { id, warning? }.
import { scheduleVisit } from '@/modules/visits';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('lead-visit', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return scheduleVisit(ctx, params.id, {
    scheduledFor: s(body.scheduledFor),
    location: s(body.location),
    assigneeUserId: s(body.assigneeUserId) || undefined,
    propertyIds: Array.isArray(body.propertyIds)
      ? body.propertyIds.filter((v): v is string => typeof v === 'string')
      : undefined,
  });
});
