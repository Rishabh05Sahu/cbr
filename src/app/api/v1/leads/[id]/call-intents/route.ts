// POST /api/v1/leads/:id/call-intents — FR-080/081 Call or WhatsApp tap (ADR-0025). Body:
// { channel: 'PHONE_NATIVE' | 'WHATSAPP_APP', numberKind?: 'PRIMARY' | 'ALTERNATE', confirmInvalidNumber? }.
// Returns { intentId, href }: the app opens href (tel: or wa.me) and, back in the foreground,
// offers the outcome sheet (FR-082). The app never reads the call log (ADR-0006).
import { recordCallIntent } from '@/modules/interactions';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('lead-call-intent', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  return recordCallIntent(ctx, {
    leadId: params.id,
    channel: body.channel,
    numberKind: body.numberKind ?? undefined,
    confirmInvalidNumber: body.confirmInvalidNumber === true,
  });
});
