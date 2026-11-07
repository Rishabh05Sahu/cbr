// FR-150 visit reminders (ADR-0022; migration 0026), the FR-106 pattern: app.site_visit_reminders_claim
// records each due reminder once per visit, recipient (the assignee and the person who scheduled the
// visit) and fire time, and writes an outbox event 'site_visit.reminder_due' in the same statement.
// The notification worker delivers it in-app after re-checking the visit. 15 minutes before.
import { tenantRunner } from '@/platform/db';
import { uuidv7 } from '@/lib/uuidv7';
import { REMINDER_OFFSET_MINUTES } from '@/modules/tasks/reminders';

const VISIT_REMINDER_ACTOR = uuidv7();

/** Records and announces the visit reminders due now; returns how many were recorded. */
export async function claimDueVisitReminders(limit = 200): Promise<number> {
  const [row] = await tenantRunner().withUser(
    VISIT_REMINDER_ACTOR,
    (tx) =>
      tx.$queryRaw<{ n: number }[]>`
        SELECT app.site_visit_reminders_claim(${limit}::int, ${REMINDER_OFFSET_MINUTES}::int) AS n`,
  );
  return row?.n ?? 0;
}
