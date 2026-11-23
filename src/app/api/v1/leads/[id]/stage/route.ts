// POST /api/v1/leads/:id/stage — change a lead's stage from the app, the same command as the
// website's Change stage card (changeStage: lead.update_stage over the lead, the allowed
// transitions, reasons, visit time and nurture date). Body: { toStage, version, reasonCode?,
// reasonText?, visitAt?, nurtureUntil? }. Only these fields are read.
import { changeStage } from '@/modules/leads';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const FIELDS = [
  'toStage',
  'version',
  'reasonCode',
  'reasonText',
  'visitAt',
  'nurtureUntil',
] as const;

export const POST = apiRoute<{ id: string }>('lead-stage', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  return changeStage(
    ctx,
    params.id,
    Object.fromEntries(
      FIELDS.map((k) => [k, body[k] === undefined || body[k] === null ? '' : String(body[k])]),
    ),
  );
});
