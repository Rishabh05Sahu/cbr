// POST /api/v1/leads/:id/contact — edit a lead's name, alternate number, email, language and
// preferred contact method from the app (owner request 2026-11-24). updateContactDetails checks
// lead.update over the lead, a writable lead and the version; the main number is not changed.
// Body: { version, fullName, alternatePhone?, email?, preferredLanguage?, preferredContactMethod? }
// — leave alternatePhone out to keep it (it is never sent while numbers are masked).
import { updateContactDetails } from '@/modules/leads';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const FIELDS = [
  'version',
  'fullName',
  'alternatePhone',
  'email',
  'preferredLanguage',
  'preferredContactMethod',
] as const;

export const POST = apiRoute<{ id: string }>('lead-contact', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  const input: Record<string, string> = {};
  for (const k of FIELDS) {
    const v = body[k];
    if (typeof v === 'string' || typeof v === 'number') input[k] = String(v);
  }
  return updateContactDetails(ctx, params.id, input);
});
