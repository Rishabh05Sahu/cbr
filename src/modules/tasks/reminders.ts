// FR-106 task reminders (ADR-0019; migration 0023). The database is the source of truth:
// app.task_reminders_claim() records each due reminder once (task_reminder, unique per task,
// offset and fire time) and writes an outbox event 'task.reminder_due' in the same statement. The
// relay and the notification worker deliver it in-app to the task's current assignee, after
// re-checking the task (notifications.build). Called by the worker every 30 s; a repeated or
// concurrent call records nothing twice.
import { tenantRunner } from '@/platform/db';
import { uuidv7 } from '@/lib/uuidv7';

/** FR-106 default: 15 minutes before the due time. The only offset until one is configurable. */
export const REMINDER_OFFSET_MINUTES = 15;
/** How often the worker claims due reminders (NFR-007: delivered within 60 s, p95). */
export const REMINDER_SWEEP_MS = 30_000;

/** The claim runs across orgs; a system user id only opens the transaction (as the relay). */
const REMINDER_ACTOR = uuidv7();

/** Records and announces the reminders due now; returns how many were recorded. */
export async function claimDueReminders(limit = 200): Promise<number> {
  const [row] = await tenantRunner().withUser(
    REMINDER_ACTOR,
    (tx) =>
      tx.$queryRaw<{ n: number }[]>`
        SELECT app.task_reminders_claim(${limit}::int, ${REMINDER_OFFSET_MINUTES}::int) AS n`,
  );
  return row?.n ?? 0;
}
