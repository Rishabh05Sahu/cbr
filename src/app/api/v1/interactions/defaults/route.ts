// GET /api/v1/interactions/defaults — what the app's outcome sheet needs (FR-083/084): the time
// defaults from the org, and for each channel the allowed outcomes in display order with the
// website's labels. The rules and labels stay on the server (rules.ts), so the app and the
// website cannot drift apart.
//
// `channels` (app ≤ 1.0.3): the three outbound channels the first app versions log, outbound
// outcomes only. `allChannels` (app 1.0.4, owner request 2026-11-23: the same sheet as the website)
// has every channel with its outbound and inbound outcomes and whether a duration applies;
// `directions`, `dncMethods` and `requirementOptions` carry the website's other choices.
import { LABELS } from '@/app/(app)/app/leads/labels';
import {
  allowedOutcomes,
  CHANNEL_LABELS,
  CHANNELS,
  DIRECTION_LABELS,
  DIRECTIONS,
  durationAllowed,
  OUTCOME_GROUPS,
  OUTCOME_LABELS,
  requestedContactStatus,
  sheetDefaults,
  type Channel,
  type Direction,
} from '@/modules/interactions';
import {
  CONTACT_METHOD_LABELS,
  DNC_METHODS,
  INTENTS,
  PROPERTY_TYPES,
  PURPOSES,
  TIMELINES,
  TRANSACTION_TYPES,
} from '@/modules/leads';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const APP_CHANNELS: Channel[] = ['PHONE_NATIVE', 'WHATSAPP_APP_CALL', 'WHATSAPP_APP_MESSAGE'];

const outcomes = (code: Channel, direction: Direction) =>
  allowedOutcomes(code, direction).map((o) => ({
    code: o,
    label: OUTCOME_LABELS[o],
    group: OUTCOME_GROUPS[o],
    // Q3: such an outcome asks for the lead's contact status to change (confirmation needed).
    requestsStatus: requestedContactStatus(o),
  }));
const options = (codes: readonly string[]) =>
  codes.map((code) => ({ code, label: LABELS[code] ?? code }));

export const GET = apiRoute('interaction-defaults', async ({ ctx }) => ({
  ...(await sheetDefaults(ctx)),
  direction: 'OUTBOUND',
  channels: APP_CHANNELS.map((code) => ({
    code,
    label: CHANNEL_LABELS[code],
    outcomes: outcomes(code, 'OUTBOUND'),
  })),
  allChannels: CHANNELS.map((code) => ({
    code,
    label: CHANNEL_LABELS[code],
    durationAllowed: durationAllowed(code),
    outbound: outcomes(code, 'OUTBOUND'),
    inbound: outcomes(code, 'INBOUND'),
  })),
  directions: DIRECTIONS.map((code) => ({ code, label: DIRECTION_LABELS[code] })),
  dncMethods: DNC_METHODS.map((code) => ({ code, label: CONTACT_METHOD_LABELS[code] ?? code })),
  requirementOptions: {
    transactionType: options(TRANSACTION_TYPES),
    propertyType: options(PROPERTY_TYPES),
    purpose: options(PURPOSES),
    timeline: options(TIMELINES),
    intent: options(INTENTS),
  },
}));
