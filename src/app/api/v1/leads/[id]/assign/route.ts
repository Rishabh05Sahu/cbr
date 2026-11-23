// POST /api/v1/leads/:id/assign — assign or reassign one lead (FR-070, Workflow G), the same
// command as the web lead page. Body: { target: "user:<id>" | "team:<id>" | "queue", version,
// reason } — a reason is required when the lead already has an owner (lead.reassign).
import { assignLead } from '@/modules/leads';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('lead-assign', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  await assignLead(ctx, params.id, {
    target: body.target,
    version: body.version,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
  });
  return { assigned: true };
});
