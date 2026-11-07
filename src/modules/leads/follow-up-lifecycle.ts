// Open lead tasks when a lead's ownership or stage changes, or their assignee leaves (Phase 3
// slice 2, ADR-0010). Since FR-100's other types (ADR-0015, owner decision 2026-10-29) these rules
// apply to a lead's open tasks of every type; the one-per-lead collision rule is for follow-ups
// only (FR-108). A task with no lead is cancelled when its assignee is deactivated. Runs inside the caller's transaction, so the lead change and the
// follow-up changes commit together. Plain SQL here because the tasks module depends on leads,
// not the other way round (as in merge.ts, ADR-0009 #8).
//
//   Reassignment (workflow G): the previous owner's open follow-ups on the lead move to the new
//     owner. Without a new owner (a queue) they are cancelled with a reason.
//   Deactivation (FR-077): after the member's own leads are handed over, each remaining open
//     follow-up goes to its lead's active owner, or is cancelled with a reason if there is none.
//   Collision: the destination person already has an open follow-up on the lead (one per lead
//     and person, FR-108): theirs is kept and the incoming one is cancelled with a reason.
//   Won/Lost: every open task on the lead is cancelled with a reason.
//   No lead: on deactivation, the member's open tasks with no lead are cancelled with a reason.
// Nothing is deleted; completed and cancelled follow-ups never change (task_guard). Each change
// writes a TASK timeline entry; lead.next_follow_up_at follows through its trigger.
import { writeAudit } from '@/modules/audit';
import type { RequestContext } from '@/platform/authz';
import type { Tx } from '@/platform/db';

export type HandoverCause = 'REASSIGNED' | 'DEACTIVATED';

const REASONS = {
  REASSIGNED: {
    noOwner: 'Lead moved to a queue without an owner',
    collision: 'Lead reassigned: the new owner already had an open follow-up',
  },
  DEACTIVATED: {
    noOwner: 'Assignee deactivated and the lead has no active owner',
    collision: 'Assignee deactivated: the lead owner already had an open follow-up',
  },
} as const;

/**
 * Cancels the matching open tasks on a lead with `reason`; returns how many. With
 * `onlyIfHeldBy`, only follow-ups that collide with one of that person's open follow-ups.
 */
async function cancelOpen(
  tx: Tx,
  ctx: RequestContext,
  leadId: string,
  assigneeUserId: string | null,
  reason: string,
  onlyIfHeldBy: string | null,
): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    `WITH c AS (
       UPDATE task t
          SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $3::text,
              version = t.version + 1, updated_at = now()
        WHERE t.lead_id = $1::uuid AND t.status = 'OPEN'
          AND ($2::uuid IS NULL OR t.assignee_user_id = $2::uuid)
          AND ($4::uuid IS NULL OR (t.type = 'FOLLOW_UP' AND EXISTS (
                SELECT 1 FROM task s
                 WHERE s.lead_id = t.lead_id AND s.assignee_user_id = $4::uuid
                   AND s.status = 'OPEN' AND s.type = 'FOLLOW_UP' AND s.id <> t.id)))
        RETURNING t.id, t.due_at, t.type)
     INSERT INTO lead_activity (org_id, lead_id, type, actor_id, summary, ref_type, ref_id)
     SELECT $5::uuid, $1::uuid, 'TASK', $6::uuid,
            jsonb_build_object('action', 'cancelled', 'dueAt', c.due_at, 'reason', $3::text,
                               'automatic', true)
              || CASE WHEN c.type = 'FOLLOW_UP' THEN '{}'::jsonb
                      ELSE jsonb_build_object('taskType', c.type) END,
            'task', c.id
       FROM c
     RETURNING ref_id AS id`,
    leadId,
    assigneeUserId,
    reason,
    onlyIfHeldBy,
    ctx.orgId,
    ctx.userId,
  );
  return rows.length;
}

/**
 * Hands `fromUserId`'s open tasks on one lead to `toUserId` (an active member; the database
 * re-checks), or cancels them when there is no one to hand to. Writes one audit entry when
 * anything changed.
 */
export async function handOverLeadFollowUps(
  tx: Tx,
  ctx: RequestContext,
  leadId: string,
  fromUserId: string,
  toUserId: string | null,
  cause: HandoverCause,
): Promise<{ moved: number; cancelled: number }> {
  if (toUserId === fromUserId) return { moved: 0, cancelled: 0 };
  const reasons = REASONS[cause];
  const cancelled = toUserId
    ? await cancelOpen(tx, ctx, leadId, fromUserId, reasons.collision, toUserId)
    : await cancelOpen(tx, ctx, leadId, fromUserId, reasons.noOwner, null);
  let moved = 0;
  if (toUserId) {
    const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
      `WITH m AS (
         UPDATE task t
            SET assignee_user_id = $3::uuid, version = t.version + 1, updated_at = now()
          WHERE t.lead_id = $1::uuid AND t.assignee_user_id = $2::uuid AND t.status = 'OPEN'
          RETURNING t.id, t.due_at, t.type)
       INSERT INTO lead_activity (org_id, lead_id, type, actor_id, summary, ref_type, ref_id)
       SELECT $4::uuid, $1::uuid, 'TASK', $5::uuid,
              jsonb_build_object('action', 'handed_over', 'dueAt', m.due_at,
                                 'fromUserId', $2::uuid, 'toUserId', $3::uuid, 'cause', $6::text)
                || CASE WHEN m.type = 'FOLLOW_UP' THEN '{}'::jsonb
                        ELSE jsonb_build_object('taskType', m.type) END,
              'task', m.id
         FROM m
       RETURNING ref_id AS id`,
      leadId,
      fromUserId,
      toUserId,
      ctx.orgId,
      ctx.userId,
      cause,
    );
    moved = rows.length;
  }
  if (moved || cancelled)
    await writeAudit(tx, ctx.orgId, {
      action: 'task.handed_over',
      entityType: 'lead',
      entityId: leadId,
      actorUserId: ctx.userId,
      metadata: { fromUserId, toUserId, moved, cancelled, cause },
    });
  return { moved, cancelled };
}

/**
 * FR-077: hands over every open lead task still assigned to a departing member (call after
 * their own leads were handed over). Each goes to its lead's active owner; with none, it is
 * cancelled with a reason. Their open tasks with no lead are cancelled with a reason (owner
 * decision 2026-10-29, ADR-0015) and audited once.
 */
export async function handOverFollowUpsOf(
  tx: Tx,
  ctx: RequestContext,
  userId: string,
): Promise<{ moved: number; cancelled: number }> {
  const leads = await tx.$queryRawUnsafe<{ lead_id: string; owner: string | null }[]>(
    `SELECT DISTINCT t.lead_id,
            CASE WHEN m.status = 'ACTIVE' AND l.owner_user_id <> $1::uuid
                 THEN l.owner_user_id END AS owner
       FROM task t
       JOIN lead l ON l.id = t.lead_id
       LEFT JOIN organization_membership m
              ON m.org_id = l.org_id AND m.user_id = l.owner_user_id
      WHERE t.assignee_user_id = $1::uuid AND t.status = 'OPEN'
      ORDER BY t.lead_id`,
    userId,
  );
  const total = { moved: 0, cancelled: 0 };
  for (const l of leads) {
    const r = await handOverLeadFollowUps(tx, ctx, l.lead_id, userId, l.owner, 'DEACTIVATED');
    total.moved += r.moved;
    total.cancelled += r.cancelled;
  }
  const own = await tx.$queryRawUnsafe<{ id: string }[]>(
    `UPDATE task t
        SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2::text,
            version = t.version + 1, updated_at = now()
      WHERE t.assignee_user_id = $1::uuid AND t.status = 'OPEN' AND t.lead_id IS NULL
      RETURNING t.id`,
    userId,
    NO_LEAD_DEACTIVATED,
  );
  // FR-107 (ADR-0020): a departing member's recurring series stop (no further occurrences).
  await tx.$executeRawUnsafe(
    `UPDATE task_series SET stopped_at = now(), stopped_by = $2::uuid, version = version + 1,
            updated_at = now()
      WHERE owner_user_id = $1::uuid AND stopped_at IS NULL`,
    userId,
    ctx.userId,
  );
  if (own.length) {
    total.cancelled += own.length;
    await writeAudit(tx, ctx.orgId, {
      action: 'task.cancelled',
      entityType: 'user',
      entityId: userId,
      actorUserId: ctx.userId,
      metadata: { cancelled: own.length, cause: 'DEACTIVATED', noLead: true },
    });
  }
  return total;
}

const NO_LEAD_DEACTIVATED = 'Assignee deactivated';

/** Won/Lost: cancels every open task on the lead, in the stage change's transaction. */
export async function closeFollowUpsForStage(
  tx: Tx,
  ctx: RequestContext,
  leadId: string,
  stage: 'WON' | 'LOST',
): Promise<number> {
  const cancelled = await cancelOpen(
    tx,
    ctx,
    leadId,
    null,
    stage === 'WON' ? 'Lead marked as Won' : 'Lead marked as Lost',
    null,
  );
  if (cancelled)
    await writeAudit(tx, ctx.orgId, {
      action: 'task.cancelled',
      entityType: 'lead',
      entityId: leadId,
      actorUserId: ctx.userId,
      metadata: { cancelled, cause: `LEAD_${stage}` },
    });
  return cancelled;
}
