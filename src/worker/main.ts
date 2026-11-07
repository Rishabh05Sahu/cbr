// Worker entrypoint (ADR-0005): outbox relay loop + BullMQ workers. Same image as web.
import { Worker } from 'bullmq';
import { serverEnv } from '@/env';
import { sweepExportFiles } from '@/modules/exports/cleanup';
import { processExportJob } from '@/modules/exports/processor';
import { sweepImportFiles } from '@/modules/imports/cleanup';
import { processImportJob } from '@/modules/imports/processor';
import { claimDueReminders, REMINDER_SWEEP_MS } from '@/modules/tasks/reminders';
import { claimDueVisitReminders } from '@/modules/visits/reminders';
import {
  exportFilesDue,
  importFilesDue,
  isCleanupConfigured,
  markExportFileDeleted,
} from '@/platform/db/cleanup';
import { disconnectAll } from '@/platform/db/client';
import { createSmtpSender } from '@/platform/email/sender';
import type { EmailMessage } from '@/platform/email/templates';
import { logger } from '@/platform/observability/logger';
import {
  closeQueues,
  connection,
  QUEUE,
  type DomainEventJob,
  type ExportJobMessage,
  type ImportJobMessage,
} from '@/platform/queue';
import { exportStorage, importStorage, isStorageConfigured } from '@/platform/storage';
import { handleDomainEvent, handleEmail } from './handlers';
import { relayOnce } from './relay';

// Fail fast on bad configuration (an unknown IMPORT_COMMIT_STRATEGY included).
const { IMPORT_COMMIT_STRATEGY: importCommitStrategy } = serverEnv();
logger.info({ importCommitStrategy }, 'import commit strategy');

const sender = createSmtpSender();

const emailWorker = new Worker<EmailMessage>(
  QUEUE.email,
  async (job) => {
    const id = await handleEmail(sender, job.data);
    logger.info({ jobId: job.id, template: job.data.template, messageId: id }, 'email sent');
  },
  { connection: connection(), concurrency: 5 },
);

const eventWorker = new Worker<DomainEventJob>(
  QUEUE.events,
  async (job) => {
    const result = await handleDomainEvent(job.data);
    logger.info(
      { jobId: job.id, type: job.data.type, orgId: job.data.orgId, result },
      'event handled',
    );
  },
  { connection: connection(), concurrency: 10 },
);

// Phase 2 M4: import steps (analyse / validate / import batches). Low concurrency: each job holds
// one parsed file in memory (bounded by the import limits). The step reads the job's state, so
// a retried or duplicate message is harmless.
const importWorker = new Worker<ImportJobMessage>(
  QUEUE.imports,
  async (job) => {
    if (!isStorageConfigured()) throw new Error('import storage is not configured');
    const outcome = await processImportJob(job.data.orgId, job.data.importJobId, {
      storage: importStorage(),
      commitStrategy: importCommitStrategy,
    });
    logger.info(
      {
        jobId: job.id,
        importJobId: job.data.importJobId,
        orgId: job.data.orgId,
        outcome,
        importCommitStrategy,
      },
      'import step',
    );
  },
  { connection: connection(), concurrency: 2, lockDuration: 120_000 },
);

// Phase 2 M5: lead export generation, as the requesting Owner (re-checked before start and
// before READY). Failures are recorded on the job; the queue does not retry.
const exportWorker = new Worker<ExportJobMessage>(
  QUEUE.exports,
  async (job) => {
    if (!isStorageConfigured()) throw new Error('export storage is not configured');
    const outcome = await processExportJob(
      job.data.orgId,
      job.data.exportJobId,
      job.data.requestedBy,
      { storage: exportStorage() },
    );
    logger.info(
      { jobId: job.id, exportJobId: job.data.exportJobId, orgId: job.data.orgId, outcome },
      'export step',
    );
  },
  // 60 s lock (renewed while alive): a crashed worker's job is redelivered as stalled and the
  // processor re-claims it once its 90 s claim lease has passed (fenced; see processor.ts).
  { connection: connection(), concurrency: 1, lockDuration: 60_000 },
);

for (const w of [emailWorker, eventWorker, importWorker, exportWorker]) {
  // Job data may contain addresses/links: log ids and error names only.
  w.on('failed', (job, err) =>
    logger.warn(
      { queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.name },
      'job failed',
    ),
  );
}

let stopping = false;
async function relayLoop() {
  while (!stopping) {
    try {
      const n = await relayOnce();
      if (n === 0) await new Promise((r) => setTimeout(r, 1_000));
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'outbox relay error');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
void relayLoop();

// Phase 2 M4/M5: delete expired import and export files (runbook §6). The due lists and the
// export marker come from the dedicated crm_cleanup connection, the only one allowed to call
// app.import_files_due, app.export_files_due and app.export_file_deleted. Exports are swept
// every 5 minutes so a file never outlives its one-hour retention by much.
const SWEEP_EVERY_MS = 5 * 60_000;
async function cleanupLoop() {
  if (!isCleanupConfigured() || !isStorageConfigured()) {
    logger.warn('file cleanup disabled (CLEANUP_DATABASE_URL or storage not configured)');
    return;
  }
  while (!stopping) {
    try {
      const due = await importFilesDue(100);
      if (due.length) {
        const r = await sweepImportFiles(due, importStorage());
        logger.info({ due: due.length, ...r }, 'import file sweep');
        if (r.refused) logger.warn({ refused: r.refused }, 'import file sweep refused rows');
        if (due.length === 100 && r.deleted > 0) continue;
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.name : 'unknown' }, 'import file sweep error');
    }
    try {
      const due = await exportFilesDue(100);
      if (due.length) {
        const r = await sweepExportFiles(due, exportStorage(), markExportFileDeleted);
        logger.info({ due: due.length, ...r }, 'export file sweep');
        if (r.refused) logger.warn({ refused: r.refused }, 'export file sweep refused rows');
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.name : 'unknown' }, 'export file sweep error');
    }
    await new Promise((r) => setTimeout(r, SWEEP_EVERY_MS));
  }
}
void cleanupLoop();

// FR-106 (ADR-0019): record due task reminders every 30 s. The claim writes outbox events, which
// the relay above delivers to the notification worker. Repeating a claim records nothing twice.
async function reminderLoop() {
  while (!stopping) {
    try {
      const n = await claimDueReminders();
      if (n) logger.info({ reminders: n }, 'task reminders recorded');
      // FR-150 (ADR-0022): site-visit reminders, the same way.
      const v = await claimDueVisitReminders();
      if (v) logger.info({ reminders: v }, 'site visit reminders recorded');
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.name : 'unknown' },
        'task reminder sweep error',
      );
    }
    await new Promise((r) => setTimeout(r, REMINDER_SWEEP_MS));
  }
}
void reminderLoop();
logger.info('worker started');

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker stopping');
  await Promise.allSettled([
    emailWorker.close(),
    eventWorker.close(),
    importWorker.close(),
    exportWorker.close(),
  ]);
  await closeQueues();
  await disconnectAll();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
