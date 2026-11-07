// Open site visits when a lead closes (ADR-0022). Runs inside the stage change's transaction, as
// follow-up-lifecycle.ts does for tasks: a Won or Lost lead keeps no open visit (the database
// refuses the stage change otherwise, lead_closed_visit_guard). Each visit is cancelled with a
// reason, with its history event, a SITE_VISIT timeline entry and one audit entry for the lead.
// Plain SQL because the visits module depends on leads, not the other way round.
import { writeAudit } from '@/modules/audit';
import type { RequestContext } from '@/platform/authz';
import type { Tx } from '@/platform/db';

export async function closeVisitsForStage(
  tx: Tx,
  ctx: RequestContext,
  leadId: string,
  stage: 'WON' | 'LOST',
): Promise<number> {
  const reason = stage === 'WON' ? 'Lead marked as Won' : 'Lead marked as Lost';
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `WITH c AS (
       UPDATE site_visit v
          SET status = 'CANCELLED', cancel_reason = $2::text, closed_at = now(),
              version = v.version + 1, updated_at = now()
        WHERE v.lead_id = $1::uuid AND v.status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED')
        RETURNING v.id, v.org_id, v.scheduled_for, v.status AS to_status),
     e AS (
       INSERT INTO site_visit_event (org_id, site_visit_id, from_status, to_status, scheduled_for, reason, actor_id)
       SELECT c.org_id, c.id, NULL, 'CANCELLED', c.scheduled_for, $2::text, $3::uuid FROM c
       RETURNING site_visit_id)
     INSERT INTO lead_activity (org_id, lead_id, type, actor_id, summary, ref_type, ref_id)
     SELECT c.org_id, $1::uuid, 'SITE_VISIT', $3::uuid,
            jsonb_build_object('action', 'cancelled', 'scheduledFor', c.scheduled_for,
                               'reason', $2::text, 'automatic', true),
            'site_visit', c.id
       FROM c
     RETURNING ref_id AS id`,
    leadId,
    reason,
    ctx.userId,
  );
  if (rows.length)
    await writeAudit(tx, ctx.orgId, {
      action: 'site_visit.cancelled',
      entityType: 'lead',
      entityId: leadId,
      actorUserId: ctx.userId,
      metadata: { cancelled: rows.length, cause: `LEAD_${stage}` },
    });
  return rows.length;
}
