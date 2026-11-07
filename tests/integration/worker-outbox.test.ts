// Outbox -> relay -> BullMQ -> handler -> email adapter -> Mailpit, end to end (local).
import { Job } from 'bullmq';
import { beforeAll, describe, expect, it } from 'vitest';
import * as members from '@/modules/members';
import { createSmtpSender } from '@/platform/email/sender';
import type { EmailMessage } from '@/platform/email/templates';
import { queue, QUEUE, type DomainEventJob } from '@/platform/queue';
import { UnrecoverableError } from 'bullmq';
import { handleDomainEvent, handleEmail } from '@/worker/handlers';
import { relayOnce } from '@/worker/relay';
import { migrator } from '../support/db';
import { actorIn, seedOrg } from '../support/factory';

const MAILPIT = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:54025';

async function mailpitMessagesTo(address: string): Promise<{ Subject: string; Snippet: string }[]> {
  const res = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  return ((await res.json()) as { messages: { Subject: string; Snippet: string }[] }).messages;
}

let org: Awaited<ReturnType<typeof seedOrg>>;
beforeAll(async () => {
  org = await seedOrg('Outbox');
});

describe('transactional outbox', () => {
  it('a suspension writes the event in the same transaction; the relay publishes it once', async () => {
    const admin = await actorIn(org.users.admin, org.orgId);
    await members.suspendMember(admin.ctx, org.membership.exec1!);
    const ev = await migrator().outboxEvent.findFirstOrThrow({
      where: { orgId: org.orgId, type: 'membership.suspended' },
    });
    expect(ev.publishedAt).toBeNull();

    expect(await relayOnce()).toBeGreaterThanOrEqual(1);
    // Earlier suites in the same run may have left more than one relay batch (100) pending.
    while ((await relayOnce()) > 0);
    expect(
      (await migrator().outboxEvent.findUniqueOrThrow({ where: { id: ev.id } })).publishedAt,
    ).not.toBeNull();
    expect(await relayOnce()).toBe(0); // nothing left; already-published events are not re-sent

    const job = await Job.fromId<DomainEventJob>(queue(QUEUE.events), ev.id);
    expect(job?.data).toMatchObject({
      eventId: ev.id,
      orgId: org.orgId,
      type: 'membership.suspended',
    });
  });

  it('re-enqueueing the same event is deduplicated by jobId', async () => {
    const ev = await migrator().outboxEvent.findFirstOrThrow({
      where: { orgId: org.orgId, type: 'membership.suspended' },
    });
    const before = await queue(QUEUE.events).getJobCounts(
      'waiting',
      'delayed',
      'active',
      'completed',
    );
    await queue(QUEUE.events).add(
      ev.type,
      { eventId: ev.id, orgId: ev.orgId, type: ev.type, payload: ev.payload },
      { jobId: ev.id },
    );
    const after = await queue(QUEUE.events).getJobCounts(
      'waiting',
      'delayed',
      'active',
      'completed',
    );
    expect(after).toEqual(before);
  });

  it('the handler runs under the event org and queues the notification email; a mismatched org is skipped', async () => {
    const ev = await migrator().outboxEvent.findFirstOrThrow({
      where: { orgId: org.orgId, type: 'membership.suspended' },
    });
    const job = { eventId: ev.id, orgId: ev.orgId, type: ev.type, payload: ev.payload };
    expect(await handleDomainEvent(job)).toBe('email-queued');
    const other = await seedOrg('OutboxOther');
    expect(await handleDomainEvent({ ...job, eventId: `${ev.id}-x`, orgId: other.orgId })).toBe(
      'skipped',
    );
    await expect(handleDomainEvent({ ...job, type: 'unknown.event' })).rejects.toThrow(/unknown/);
  });

  it('the email adapter delivers through SMTP to Mailpit', async () => {
    const message: EmailMessage = {
      template: 'membership-suspended',
      to: org.users.exec1.email,
      params: { name: 'Exec', orgName: org.name },
    };
    await handleEmail(createSmtpSender(), message);
    const found = await mailpitMessagesTo(org.users.exec1.email);
    expect(found.some((m) => m.Subject === `Access to ${org.name} suspended`)).toBe(true);
  });

  it('permanent SMTP rejections fail without retry; temporary ones are retried', async () => {
    const message: EmailMessage = {
      template: 'membership-suspended',
      to: 'someone@example.test',
      params: { name: 'X', orgName: 'Y' },
    };
    const failing = (responseCode?: number) => ({
      send: async () => {
        throw Object.assign(new Error('rejected someone@example.test'), { responseCode });
      },
    });
    const permanent = await handleEmail(failing(554), message).catch((e: Error) => e);
    expect(permanent).toBeInstanceOf(UnrecoverableError);
    expect((permanent as Error).message).toBe('permanent SMTP failure 554');
    for (const code of [454, undefined]) {
      const transient = await handleEmail(failing(code), message).catch((e: Error) => e);
      expect(transient).not.toBeInstanceOf(UnrecoverableError);
    }
  });
});
