// Outbox relay: claims pending events across orgs through app.outbox_claim (definer, lease +
// SKIP LOCKED), enqueues them with jobId = event id (dedup), then marks them published.
// A crash between enqueue and mark-published re-relays the event; BullMQ dedups it.
import { tenantRunner } from '@/platform/db';
import { enqueueDomainEvent } from '@/platform/queue';
import { uuidv7 } from '@/lib/uuidv7';

interface Claimed {
  id: string;
  org_id: string;
  type: string;
  payload: unknown;
  attempts: number;
}

/** The relay is not tenant-scoped; it uses a system user id only to open a transaction. */
const RELAY_ACTOR = uuidv7();

export async function relayOnce(limit = 100): Promise<number> {
  const claimed = await tenantRunner().withUser(
    RELAY_ACTOR,
    (tx) => tx.$queryRaw<Claimed[]>`SELECT * FROM app.outbox_claim(${limit}::int, 30)`,
  );
  if (claimed.length === 0) return 0;
  const published: string[] = [];
  for (const e of claimed) {
    await enqueueDomainEvent({ eventId: e.id, orgId: e.org_id, type: e.type, payload: e.payload });
    published.push(e.id);
  }
  await tenantRunner().withUser(
    RELAY_ACTOR,
    (tx) => tx.$queryRaw`SELECT app.outbox_mark_published(${published}::uuid[])`,
  );
  return published.length;
}
