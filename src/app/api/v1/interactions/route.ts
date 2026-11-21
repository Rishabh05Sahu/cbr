// POST /api/v1/interactions — FR-083/084 log an outcome, with the same fields as the web sheet
// (src/modules/interactions/actions.ts). The idempotencyKey makes an offline retry safe.
// Server-owned values (org, actor, source, logged-at) are never read from the body.
import { logInteraction } from '@/modules/interactions';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const FIELDS = [
  'leadId',
  'idempotencyKey',
  'scriptVersionId',
  'version',
  'channel',
  'direction',
  'outcome',
  'occurredAt',
  'durationMinutes',
  'notes',
  'confirmInvalidNumber',
  'confirmStatusChange',
  'statusReason',
  'statusMethod',
  'statusEvidenceRef',
  'requirementFields',
  'transactionType',
  'propertyType',
  'bhkMin',
  'bhkMax',
  'budgetMin',
  'budgetMax',
  'preferredCity',
  'preferredLocalities',
  'purpose',
  'timeline',
  'intent',
  'followUpTaskId',
  'followUpVersion',
  'completeFollowUp',
  'nextDueAt',
  'nextTitle',
  'rescheduleReason',
] as const;

/** The web form sends strings and the module parses them, so the app's values become strings. */
const asField = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

export const POST = apiRoute('interactions', async ({ req, ctx }) => {
  const body = await readJson(req);
  return logInteraction(ctx, Object.fromEntries(FIELDS.map((k) => [k, asField(body[k])])));
});
