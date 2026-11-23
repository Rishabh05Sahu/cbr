// POST /api/v1/visits/:id — confirm, reschedule, cancel, no-show or attended (FR-151/152), the same
// command as the website (updateVisit: site_visit.manage over the visit's lead, a writable lead,
// the transition and time rules, and the expected version). Body: { action, version, scheduledFor?,
// reason?, interestLevel?, objections?, notes?, nextAction? }. Only these fields are read.
import { updateVisit } from '@/modules/visits';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const FIELDS = [
  'action',
  'version',
  'scheduledFor',
  'reason',
  'interestLevel',
  'objections',
  'notes',
  'nextAction',
] as const;

export const POST = apiRoute<{ id: string }>('visit-update', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  const input = Object.fromEntries(
    FIELDS.map((k) => [k, body[k] === undefined || body[k] === null ? '' : String(body[k])]),
  );
  return updateVisit(ctx, params.id, input);
});
