// Push devices (FR-119, ADR-0027 slice 5): the Android app registers its FCM token after sign-in
// and removes it on sign-out; the worker sends each new in-app notification to the recipient's
// phones. Push is best effort: the notification centre stays the record (FR-118).
import { z } from 'zod';
import type { RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { DomainError } from '@/platform/errors';
import { logger } from '@/platform/observability/logger';
import type { PushSender } from '@/platform/push/fcm';

/** FCM registration tokens: URL-safe base64 with ':' (about 160 characters today). */
export const pushToken = z
  .string()
  .min(20)
  .max(4096)
  .regex(/^[A-Za-z0-9_:.-]+$/, 'Not a push token');

function memberOnly(ctx: RequestContext) {
  if (ctx.kind !== 'member') {
    throw new DomainError('FORBIDDEN', 'Phone notifications are for organisation members');
  }
  return ctx;
}

/** Registers this phone for the caller in the active organisation (moves it from anyone else). */
export async function registerPushDevice(ctx: RequestContext, token: unknown): Promise<void> {
  const m = memberOnly(ctx);
  const t = pushToken.parse(token);
  await tenantRunner().withTenant(m.tenant, async (tx) => {
    await tx.$queryRaw`SELECT app.push_device_register(${t})::text AS id`;
  });
}

/** Sign-out: this phone stops receiving the caller's notifications. Unknown tokens are ignored. */
export async function removePushDevice(ctx: RequestContext, token: unknown): Promise<void> {
  const m = memberOnly(ctx);
  const t = pushToken.safeParse(token);
  if (!t.success) return;
  await tenantRunner().withTenant(m.tenant, (tx) =>
    tx.pushDevice.deleteMany({ where: { token: t.data, userId: m.userId } }),
  );
}

export interface PushItem {
  recipientUserId: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
}

/**
 * Worker: send the notifications of one event to the recipients' phones. Tokens FCM reports as
 * dead are deleted. Per-phone failures are logged, not retried: a retry would send twice to
 * the phones that already got it, and the notification centre has the message anyway.
 */
export async function deliverPush(
  sender: PushSender,
  orgId: string,
  items: PushItem[],
): Promise<{ sent: number; dead: number; failed: number }> {
  const out = { sent: 0, dead: 0, failed: 0 };
  if (!items.length) return out;
  const runner = tenantRunner();
  const system = { orgId: z.uuid().parse(orgId), userId: null };
  const devices = await runner.withTenant(system, (tx) =>
    tx.pushDevice.findMany({
      where: { userId: { in: [...new Set(items.map((i) => i.recipientUserId))] } },
      select: { userId: true, token: true },
    }),
  );
  const dead: string[] = [];
  for (const item of items) {
    for (const d of devices.filter((x) => x.userId === item.recipientUserId)) {
      const r = await sender
        .send(d.token, {
          title: item.title,
          body: item.body,
          data: { type: item.type, ...(item.link ? { link: item.link } : {}) },
        })
        .catch(() => 'failed' as const);
      out[r === 'sent' ? 'sent' : r === 'dead' ? 'dead' : 'failed'] += 1;
      if (r === 'dead') dead.push(d.token);
    }
  }
  if (dead.length) {
    await runner.withTenant(system, (tx) =>
      tx.pushDevice.deleteMany({ where: { token: { in: dead } } }),
    );
  }
  if (out.failed) logger.warn({ orgId, ...out }, 'push partly failed');
  return out;
}
