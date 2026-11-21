// GET /api/v1/interactions/defaults — what the app's outcome sheet needs (FR-083/084): the time
// defaults from the org, and for each channel the app logs (outbound phone call, WhatsApp call,
// WhatsApp message) the allowed outcomes in display order with the website's labels. The rules
// and labels stay on the server (rules.ts), so the app and the website cannot drift apart.
import {
  allowedOutcomes,
  CHANNEL_LABELS,
  OUTCOME_GROUPS,
  OUTCOME_LABELS,
  requestedContactStatus,
  sheetDefaults,
  type Channel,
} from '@/modules/interactions';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const APP_CHANNELS: Channel[] = ['PHONE_NATIVE', 'WHATSAPP_APP_CALL', 'WHATSAPP_APP_MESSAGE'];

export const GET = apiRoute('interaction-defaults', async ({ ctx }) => ({
  ...(await sheetDefaults(ctx)),
  direction: 'OUTBOUND',
  channels: APP_CHANNELS.map((code) => ({
    code,
    label: CHANNEL_LABELS[code],
    outcomes: allowedOutcomes(code, 'OUTBOUND').map((o) => ({
      code: o,
      label: OUTCOME_LABELS[o],
      group: OUTCOME_GROUPS[o],
      // Q3: such an outcome asks for the lead's contact status to change (confirmation needed).
      requestsStatus: requestedContactStatus(o),
    })),
  })),
}));
