// Phone push devices (migration 0031, ADR-0027 slice 5): registration through the definer function
// only, a token moves to whoever registers it last (another member or organisation), members see
// and delete only their own rows, and the worker sends to the recipients' phones and deletes
// tokens FCM reports as dead. Synthetic tokens; no FCM call.
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { deliverPush, registerPushDevice, removePushDevice } from '@/modules/push';
import { tenantRunner } from '@/platform/db';
import type { PushMessage, PushResult, PushSender } from '@/platform/push/fcm';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let exec1: Actor;
let exec2: Actor;
let ownerB: Actor;

const token = () =>
  `f${randomBytes(12).toString('hex')}:APA91b${randomBytes(40).toString('base64url')}`;
const row = (t: string) => migrator().pushDevice.findUnique({ where: { token: t } });

class FakeSender implements PushSender {
  sent: { token: string; message: PushMessage }[] = [];
  constructor(private readonly results: Record<string, PushResult> = {}) {}
  async send(t: string, message: PushMessage): Promise<PushResult> {
    this.sent.push({ token: t, message });
    return this.results[t] ?? 'sent';
  }
}

beforeAll(async () => {
  A = await seedOrg('PushA');
  B = await seedOrg('PushB');
  exec1 = await actorIn(A.users.exec1, A.orgId);
  exec2 = await actorIn(A.users.exec2, A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('registration', () => {
  it('registers the caller in the active organisation, once per token', async () => {
    const t = token();
    await registerPushDevice(exec1.ctx, t);
    await registerPushDevice(exec1.ctx, t);
    expect(await row(t)).toMatchObject({ orgId: A.orgId, userId: A.users.exec1.id });
    expect(await migrator().pushDevice.count({ where: { token: t } })).toBe(1);
  });

  it('moves the token to whoever signs in on the phone next, across organisations too', async () => {
    const t = token();
    await registerPushDevice(exec1.ctx, t);
    await registerPushDevice(exec2.ctx, t);
    expect(await row(t)).toMatchObject({ orgId: A.orgId, userId: A.users.exec2.id });
    await registerPushDevice(ownerB.ctx, t);
    expect(await row(t)).toMatchObject({ orgId: B.orgId, userId: B.users.owner.id });
  });

  it('refuses a malformed token', async () => {
    await expect(registerPushDevice(exec1.ctx, 'short')).rejects.toBeInstanceOf(ZodError);
    await expect(registerPushDevice(exec1.ctx, 'x'.repeat(30) + ' drop')).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it('the app role cannot write rows directly, only through the function', async () => {
    await expect(
      tenantRunner().withTenant(exec1.ctx.tenant, (tx) =>
        tx.pushDevice.create({
          data: { orgId: A.orgId, userId: A.users.exec1.id, token: token() },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('visibility and sign-out', () => {
  it("a member sees and removes only their own phones; another member's stays", async () => {
    const mine = token();
    const theirs = token();
    await registerPushDevice(exec1.ctx, mine);
    await registerPushDevice(exec2.ctx, theirs);
    const seen = await tenantRunner().withTenant(exec1.ctx.tenant, (tx) =>
      tx.pushDevice.findMany({ select: { token: true } }),
    );
    expect(seen.map((r) => r.token)).toContain(mine);
    expect(seen.map((r) => r.token)).not.toContain(theirs);

    await removePushDevice(exec1.ctx, theirs);
    expect(await row(theirs)).not.toBeNull();
    await removePushDevice(exec1.ctx, mine);
    expect(await row(mine)).toBeNull();
    // Unknown or malformed tokens are ignored.
    await removePushDevice(exec1.ctx, token());
    await removePushDevice(exec1.ctx, 'nope');
  });
});

describe('worker delivery', () => {
  it("sends each notification to its recipient's phones and drops dead tokens", async () => {
    const live = token();
    const dead = token();
    const other = token();
    const otherOrg = token();
    await migrator().pushDevice.deleteMany({ where: { userId: A.users.exec1.id } });
    await registerPushDevice(exec1.ctx, live);
    await registerPushDevice(exec1.ctx, dead);
    await registerPushDevice(exec2.ctx, other);
    await registerPushDevice(ownerB.ctx, otherOrg);
    const sender = new FakeSender({ [dead]: 'dead' });

    const out = await deliverPush(sender, A.orgId, [
      {
        recipientUserId: A.users.exec1.id,
        type: 'LEAD_ASSIGNED',
        title: 'Lead assigned: Push Test',
        body: 'From the queue',
        link: '/app/leads/00000000-0000-7000-8000-000000000000',
      },
    ]);
    expect(out).toEqual({ sent: 1, dead: 1, failed: 0 });
    expect(sender.sent.map((s) => s.token).sort()).toEqual([live, dead].sort());
    expect(sender.sent[0]!.message).toEqual({
      title: 'Lead assigned: Push Test',
      body: 'From the queue',
      data: {
        type: 'LEAD_ASSIGNED',
        link: '/app/leads/00000000-0000-7000-8000-000000000000',
      },
    });
    expect(await row(dead)).toBeNull();
    expect(await row(live)).not.toBeNull();
    expect(await row(other)).not.toBeNull();
  });

  it("never reaches a phone registered in another organisation, even for the same person's id", async () => {
    const t = token();
    await registerPushDevice(ownerB.ctx, t);
    const sender = new FakeSender();
    await deliverPush(sender, A.orgId, [
      {
        recipientUserId: B.users.owner.id,
        type: 'TASK_REMINDER',
        title: 'x',
        body: 'y',
        link: null,
      },
    ]);
    expect(sender.sent).toEqual([]);
  });

  it('a failing phone is counted, not retried, and the others still get it', async () => {
    const bad = token();
    const good = token();
    await registerPushDevice(exec2.ctx, bad);
    await registerPushDevice(exec2.ctx, good);
    const sender = new FakeSender({ [bad]: 'failed' });
    const out = await deliverPush(sender, A.orgId, [
      {
        recipientUserId: A.users.exec2.id,
        type: 'TASK_ASSIGNED',
        title: 't',
        body: 'b',
        link: null,
      },
    ]);
    expect(out.failed).toBe(1);
    expect(out.sent).toBeGreaterThanOrEqual(1);
    expect(await row(bad)).not.toBeNull();
  });
});
