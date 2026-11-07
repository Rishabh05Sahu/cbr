// Job handlers. Each domain-event handler runs under withTenant(event.orgId) with a system
// actor and must be idempotent (events can be delivered more than once).
import { UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { notifyForEvent } from '@/modules/notifications';
import { tenantRunner } from '@/platform/db';
import type { EmailSender } from '@/platform/email/sender';
import type { EmailMessage } from '@/platform/email/templates';
import type { DomainEventJob } from '@/platform/queue';
import { enqueueEmail, enqueueExportJob, enqueueImportJob } from '@/platform/queue';

const membershipPayload = z.object({
  membershipId: z.uuid(),
  userId: z.uuid(),
  role: z.string().optional(),
});

export class UnknownEventType extends Error {
  override readonly name = 'UnknownEventType';
}

/** Returns what it did, for tests and logs (never the email address). */
export async function handleDomainEvent(
  job: DomainEventJob,
): Promise<'email-queued' | 'notified' | 'skipped' | 'import-queued' | 'export-queued'> {
  const orgId = z.uuid().parse(job.orgId);
  switch (job.type) {
    case 'membership.suspended':
    case 'membership.role_changed': {
      const p = membershipPayload.parse(job.payload);
      const data = await tenantRunner().withTenant({ orgId, userId: null }, async (tx) => {
        const m = await tx.member.findUnique({
          where: { id: p.membershipId },
          select: {
            userId: true,
            status: true,
            role: true,
            user: { select: { name: true, email: true } },
          },
        });
        const org = await tx.organization.findUnique({
          where: { id: orgId },
          select: { name: true },
        });
        return m && org && m.userId === p.userId ? { m, org } : null;
      });
      // Entity gone or payload/org mismatch: nothing to do (fails safe, S1-12).
      if (!data) return 'skipped';
      const message: EmailMessage =
        job.type === 'membership.suspended'
          ? {
              template: 'membership-suspended',
              to: data.m.user.email,
              params: { name: data.m.user.name, orgName: data.org.name },
            }
          : {
              template: 'role-changed',
              to: data.m.user.email,
              params: {
                name: data.m.user.name,
                orgName: data.org.name,
                role: p.role ?? data.m.role,
              },
            };
      // jobId derived from the event id: a redelivered event does not send twice.
      await enqueueEmail(message, `evt-${job.eventId}`);
      return 'email-queued';
    }
    // Phase 2 M3 in-app notifications (idempotent per event and recipient).
    case 'lead.assigned':
    case 'lead.enquiry_returned':
    // Migration 0010: the import's creator learns it finished (event written by a DB trigger).
    case 'import.finished':
    // FR-103 (ADR-0016): the assignee of a task someone else created for them.
    case 'task.assigned':
    // FR-104 (ADR-0017): members invited to a meeting.
    case 'meeting.invited':
    // FR-106 (ADR-0019): a reminder recorded by app.task_reminders_claim.
    case 'task.reminder_due':
    // FR-150 (ADR-0022): a site-visit reminder recorded by app.site_visit_reminders_claim.
    case 'site_visit.reminder_due':
      return notifyForEvent({ ...job, orgId });
    // Phase 2 M4: hand the import to its own queue (long-running, lower concurrency).
    case 'import.process_requested': {
      const p = z.object({ importJobId: z.uuid() }).parse(job.payload);
      await enqueueImportJob({ orgId, importJobId: p.importJobId }, `evt-${job.eventId}`);
      return 'import-queued';
    }
    // Phase 2 M5: hand the export to its own queue.
    case 'export.requested': {
      const p = z.object({ exportJobId: z.uuid(), requestedBy: z.uuid() }).parse(job.payload);
      await enqueueExportJob({ orgId, ...p }, `evt-${job.eventId}`);
      return 'export-queued';
    }
    default:
      throw new UnknownEventType(job.type);
  }
}

/**
 * SMTP replies 5xx are permanent (e.g. SES "554 Message rejected", address on the suppression
 * list): retrying cannot succeed, so the job fails at once instead of using its 5 attempts.
 * 4xx replies (e.g. SES "454 Throttling") and network errors are retried with backoff.
 */
export function isPermanentEmailFailure(err: unknown): boolean {
  const code = (err as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

export async function handleEmail(sender: EmailSender, message: EmailMessage): Promise<string> {
  try {
    const { messageId } = await sender.send(message);
    return messageId;
  } catch (err) {
    // The error text may echo the recipient address: only the reply code is kept.
    if (isPermanentEmailFailure(err)) {
      throw new UnrecoverableError(
        `permanent SMTP failure ${(err as { responseCode: number }).responseCode}`,
      );
    }
    throw err;
  }
}
