// Transactional outbox writer (ADR-0005): call inside the same withTenant() transaction as
// the state change. The worker relays events to BullMQ; handlers must be idempotent.
import type { Tx } from '@/platform/db';

export type DomainEvent =
  | { type: 'membership.suspended'; payload: { membershipId: string; userId: string } }
  | {
      type: 'membership.role_changed';
      payload: { membershipId: string; userId: string; role: string };
    }
  // Phase 2 M3: one event per assignment operation (bulk = one event, so one digest).
  | {
      type: 'lead.assigned';
      payload: {
        leadIds: string[];
        toUserId: string | null;
        teamId: string | null;
        /** Owners who lost these leads, with how many each (notified without lead details). */
        previousOwners: { userId: string; count: number }[];
        actorUserId: string | null;
        source: string;
      };
    }
  | {
      type: 'lead.enquiry_returned';
      payload: { leadId: string; enquiryId: string; actorUserId: string | null };
    }
  // Phase 2 M4: an import job has work for the worker (analyse, validate or import). Emitted in
  // the transaction that moved the job; the worker reads the job's state, so a redelivered or
  // stale event is a no-op.
  | { type: 'import.process_requested'; payload: { importJobId: string } }
  // An import job reached COMPLETED, COMPLETED_WITH_ERRORS or FAILED. Written ONLY by the
  // database trigger import_job_finished (migration 0010), in the status change's transaction;
  // listed here so the worker's payload type is documented. Never emitted from application code.
  | { type: 'import.finished'; payload: { importJobId: string } }
  // Phase 2 M5: an Owner requested a lead export. The worker builds it as that requester (the
  // export_job row is visible to them only) and re-checks they are still an active Owner.
  | { type: 'export.requested'; payload: { exportJobId: string; requestedBy: string } }
  // Phase 4 FR-103: a task was created for someone other than its creator (ADR-0016). The worker
  // notifies the assignee if the task is still open and still theirs.
  | {
      type: 'task.assigned';
      payload: { taskId: string; assigneeUserId: string; actorUserId: string };
    }
  // Phase 4 FR-104: members invited to a meeting (ADR-0017). The worker notifies each one still
  // invited to the still-open meeting.
  | {
      type: 'meeting.invited';
      payload: { taskId: string; userIds: string[]; actorUserId: string };
    }
  // Phase 4 FR-106: a task reminder is due (ADR-0019). Written ONLY by app.task_reminders_claim
  // (migration 0023); listed here so the worker's payload type is documented.
  | {
      type: 'task.reminder_due';
      payload: { taskId: string; offsetMinutes: number; dueAt: string; fireAt: string };
    }
  // Phase 4 FR-150: a site-visit reminder is due (ADR-0022). Written ONLY by
  // app.site_visit_reminders_claim (migration 0026).
  | {
      type: 'site_visit.reminder_due';
      payload: { siteVisitId: string; recipientUserId: string; scheduledFor: string };
    };

export async function emitEvent(tx: Tx, orgId: string, event: DomainEvent): Promise<string> {
  const row = await tx.outboxEvent.create({
    data: { orgId, type: event.type, payload: event.payload },
    select: { id: true },
  });
  return row.id;
}
