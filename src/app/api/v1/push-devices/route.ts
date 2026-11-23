// POST /api/v1/push-devices — the app registers this phone's FCM token for the signed-in member
// in the active organisation (ADR-0027 slice 5). Body: { token }.
// DELETE /api/v1/push-devices — sign-out: the phone stops receiving this member's notifications.
// Body: { token }. Unknown tokens are ignored.
import { registerPushDevice, removePushDevice } from '@/modules/push';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute('push-device-register', async ({ req, ctx }) => {
  await registerPushDevice(ctx, (await readJson(req)).token);
  return { registered: true };
});

export const DELETE = apiRoute('push-device-remove', async ({ req, ctx }) => {
  await removePushDevice(ctx, (await readJson(req)).token);
  return { removed: true };
});
