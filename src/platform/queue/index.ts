// BullMQ on Valkey (ADR-0005). Jobs are idempotent: producers pass a stable jobId.
import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { serverEnv } from '@/env';
import type { EmailMessage } from '@/platform/email/templates';

export const QUEUE = {
  email: 'email',
  events: 'events',
  imports: 'imports',
  exports: 'exports',
} as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export function connection(): ConnectionOptions {
  return { url: serverEnv().REDIS_URL, maxRetriesPerRequest: null };
}

const g = globalThis as unknown as { __crmQueues?: Map<QueueName, Queue> };
const queues = (g.__crmQueues ??= new Map());

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: connection() });
    queues.set(name, q);
  }
  return q;
}

/**
 * Auth emails carry single-use links. Completed jobs are deleted immediately and failed
 * ones after 24 h, so tokens do not linger in Valkey (D3).
 */
const EMAIL_JOB_DEFAULTS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: { age: 24 * 3600 },
};

export async function enqueueEmail(message: EmailMessage, jobId?: string): Promise<void> {
  await queue(QUEUE.email).add('email.send', message, {
    ...EMAIL_JOB_DEFAULTS,
    ...(jobId ? { jobId } : {}),
  });
}

export interface DomainEventJob {
  eventId: string;
  orgId: string;
  type: string;
  payload: unknown;
}

export async function enqueueDomainEvent(event: DomainEventJob): Promise<void> {
  // jobId = outbox event id: a re-relayed event is deduplicated by BullMQ.
  await queue(QUEUE.events).add(event.type, event, {
    jobId: event.eventId,
    attempts: 8,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 24 * 3600, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}

export interface ImportJobMessage {
  orgId: string;
  importJobId: string;
}

/**
 * Import processing (Phase 2 M4). jobId comes from the outbox event, so a re-relayed event is
 * deduplicated; the handler re-reads the job's state, so a duplicate run is harmless anyway.
 */
export async function enqueueImportJob(message: ImportJobMessage, jobId: string): Promise<void> {
  await queue(QUEUE.imports).add('import.process', message, {
    jobId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 24 * 3600, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}

export interface ExportJobMessage {
  orgId: string;
  exportJobId: string;
  requestedBy: string;
}

/**
 * Lead export generation (Phase 2 M5). One attempt: the processor records any failure on the job
 * (FAILED + code) instead of throwing, and a duplicate message finds the job no longer QUEUED.
 */
export async function enqueueExportJob(message: ExportJobMessage, jobId: string): Promise<void> {
  await queue(QUEUE.exports).add('export.build', message, {
    jobId,
    attempts: 1,
    removeOnComplete: { age: 24 * 3600, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}

export async function closeQueues(): Promise<void> {
  for (const q of queues.values()) await q.close();
  queues.clear();
}
