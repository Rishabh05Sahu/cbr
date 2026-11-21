// GET /api/v1/leads/:id — the lead screen: the lead (masked per FR-060), its tasks and visits,
// the best-matching scripts and the Call/WhatsApp tap still awaiting an outcome (FR-082). Each
// part is loaded only when the caller holds its permission, as on the web lead page. Another
// org's lead, an out-of-scope lead and a missing lead are all NOT_FOUND.
import { getLead } from '@/modules/leads';
import { pendingCallIntent } from '@/modules/interactions';
import { suggestForLead } from '@/modules/scripts';
import { followUpsForLead } from '@/modules/tasks';
import { visitsForLead } from '@/modules/visits';
import { can } from '@/platform/authz';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const SCRIPTS = 3;

export const GET = apiRoute<{ id: string }>('lead', async ({ ctx, params }) => {
  const lead = await getLead(ctx, params.id);
  const [followUps, visits, scripts, pendingTap] = await Promise.all([
    can(ctx, 'task.read') ? followUpsForLead(ctx, lead.id) : null,
    can(ctx, 'site_visit.read') ? visitsForLead(ctx, lead.id) : null,
    can(ctx, 'script.read') ? suggestForLead(ctx, lead.id).then((s) => s.slice(0, SCRIPTS)) : [],
    lead.canLogInteraction ? pendingCallIntent(ctx, lead.id) : null,
  ]);
  return { lead, followUps, visits, scripts, pendingTap };
});
