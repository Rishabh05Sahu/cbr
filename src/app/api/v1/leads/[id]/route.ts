// GET /api/v1/leads/:id — the lead screen: the lead (masked per FR-060), its tasks and visits,
// the best-matching scripts and the Call/WhatsApp tap still awaiting an outcome (FR-082). Each
// part is loaded only when the caller holds its permission, as on the web lead page. Another
// org's lead, an out-of-scope lead and a missing lead are all NOT_FOUND.
//
// App 1.0.4 (owner request 2026-11-23, parity with the web lead page): `stage` lists the stages
// the caller may move the lead to and the Lost reasons (as the Change stage card), `visitPeople`
// the salespeople a manager may book a visit for, and `nowLocal` the org-local time the app's
// pickers start from. The server re-checks all of it on every change.
import { allowedTargets, getLead, LOST_REASONS, STAGE_LABELS } from '@/modules/leads';
import { pendingCallIntent } from '@/modules/interactions';
import { suggestForLead } from '@/modules/scripts';
import { followUpsForLead } from '@/modules/tasks';
import { orgLocalInput } from '@/modules/tasks/follow-up-rules';
import { visitAssigneeOptions, visitsForLead } from '@/modules/visits';
import { can } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const SCRIPTS = 3;

export const GET = apiRoute<{ id: string }>('lead', async ({ ctx, params }) => {
  const lead = await getLead(ctx, params.id);
  const [followUps, visits, scripts, pendingTap, org] = await Promise.all([
    can(ctx, 'task.read') ? followUpsForLead(ctx, lead.id) : null,
    can(ctx, 'site_visit.read') ? visitsForLead(ctx, lead.id) : null,
    can(ctx, 'script.read') ? suggestForLead(ctx, lead.id).then((s) => s.slice(0, SCRIPTS)) : [],
    lead.canLogInteraction ? pendingCallIntent(ctx, lead.id) : null,
    tenantRunner().withTenant(ctx.tenant, (tx) =>
      tx.organization.findFirstOrThrow({ select: { timeZone: true } }),
    ),
  ]);
  const targets =
    lead.canChangeStage && !(lead.stage === 'LOST' && !lead.canReopen)
      ? allowedTargets(lead.stage)
      : [];
  const visitPeople = visits?.canSchedule ? await visitAssigneeOptions(ctx) : [];
  return {
    lead,
    followUps,
    visits,
    scripts,
    pendingTap,
    stage: {
      targets: targets.map((code) => ({ code, label: STAGE_LABELS[code] })),
      lostReasons: Object.entries(LOST_REASONS).map(([code, label]) => ({ code, label })),
    },
    visitPeople,
    nowLocal: orgLocalInput(new Date(), org.timeZone),
  };
});
