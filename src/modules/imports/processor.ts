// Import jobs, worker side (FR-040–FR-052). The worker calls processImportJob() for an
// `import.process_requested` event; it reads the job's status and does the step that status
// needs, so a duplicate or stale event is harmless:
//   UPLOADED/ANALYSING → analyse: download, verify size and hash, inspect, parse, suggest mapping
//   VALIDATING         → validate every row (a dry run: row results and counts only)
//   IMPORTING          → commit rows in batches through the leads module
//
// Identity: every step runs as the uploader. Their context is rebuilt from the database before
// analysis, before validation and before EVERY import batch (memberContext: ACTIVE membership in
// an ACTIVE org, Owner/Admin, lead.import + lead.create). If it fails while importing, the job
// is PAUSED and nothing more is written; there is no system-actor fallback.
//
// Atomic progress: each batch locks the job row, re-checks status and cursor, commits its leads
// (commitImportBatch), its row results and the new cursor in ONE transaction. A crash or retry
// re-runs from the committed cursor; lead_enquiry.external_id makes a re-run row a no-op.
// Parsing happens only here (worker), only after the file checks pass.
import { createHash } from 'node:crypto';
import { serverEnv } from '@/env';
import { writeAudit } from '@/modules/audit';
import * as leads from '@/modules/leads';
import { memberContext } from '@/platform/auth/member-context';
import { can, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { DomainError } from '@/platform/errors';
import { StorageError, type ObjectStorage } from '@/platform/storage';
import { inspectFileBytes, type ImportFileType } from './file-check';
import { importLimits, type ImportLimits } from './limits';
import { checkHeaders, suggestMapping, type ColumnMapping } from './mapping';
import { parseImportFile, type ParsedFile } from './parse';
import { InFileDuplicates, validateRow, type RowIssue } from './rows';

type Member = RequestContext & { kind: 'member' };

export interface ProcessDeps {
  storage: ObjectStorage;
  limits?: ImportLimits;
  /** Rows per import transaction (default: limits.batchRows). */
  batchRows?: number;
  /** Lead commit strategy (default 'set'; 'row' is the rollback, IMPORT_COMMIT_STRATEGY). */
  commitStrategy?: 'row' | 'set';
  /** Test hook: runs inside each batch transaction after the leads are written. */
  inBatch?: (batchIndex: number) => Promise<void> | void;
  /** Test hook: runs after each committed batch, before the next authorisation check. */
  afterBatch?: (batchIndex: number) => Promise<void> | void;
}

export type ProcessOutcome =
  | 'noop'
  | 'needs_mapping'
  | 'ready'
  | 'dry_run_completed'
  | 'completed'
  | 'paused'
  | 'cancelled'
  | 'failed';

const IN_FLIGHT = ['UPLOADED', 'ANALYSING', 'VALIDATING', 'IMPORTING'];
const HOURS = 3600_000;
const MAX_ISSUES_PER_ROW = 10;
const RESULT_CHUNK = 1000;

const system = (orgId: string) => ({ orgId, userId: null });

const JOB = {
  id: true,
  orgId: true,
  createdBy: true,
  status: true,
  fileType: true,
  byteSize: true,
  storageKey: true,
  sha256: true,
  sheetName: true,
  headers: true,
  mapping: true,
  defaultSourceId: true,
  duplicatePolicy: true,
  assignment: true,
  dryRun: true,
  validationAttempt: true,
  nextRow: true,
  rowsTotal: true,
  rowsInvalid: true,
  rowsFailed: true,
} as const;

async function readJob(orgId: string, id: string) {
  return tenantRunner().withTenant(system(orgId), (tx) =>
    tx.importJob.findUnique({ where: { id }, select: JOB }),
  );
}
type Job = NonNullable<Awaited<ReturnType<typeof readJob>>>;

export async function processImportJob(
  orgId: string,
  importJobId: string,
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  const job = await readJob(orgId, importJobId);
  if (!job) return 'noop';
  switch (job.status) {
    case 'UPLOADED':
    case 'ANALYSING':
      return analyse(job, deps);
    case 'VALIDATING':
      return validate(job, deps);
    case 'IMPORTING':
      return importRows(job, deps);
    default:
      return 'noop';
  }
}

/** The uploader's current context, or null when they may no longer import. */
export async function uploaderContext(orgId: string, userId: string): Promise<Member | null> {
  const r = await memberContext(userId, orgId);
  if (!r.ok) return null;
  return can(r.ctx, 'lead.import') && can(r.ctx, 'lead.create') ? r.ctx : null;
}

/** Ends an unfinished job as FAILED (system actor; compare-and-set on the expected states). */
async function failJob(job: Job, code: string, from = IN_FLIGHT): Promise<'failed'> {
  await tenantRunner().withTenant(system(job.orgId), async (tx) => {
    const now = new Date();
    const r = await tx.importJob.updateMany({
      where: { id: job.id, status: { in: from } },
      data: {
        status: 'FAILED',
        errorCode: code,
        finishedAt: now,
        purgeFileAfter: now,
        updatedAt: now,
        version: { increment: 1 },
      },
    });
    if (r.count === 1)
      await writeAudit(tx, job.orgId, {
        action: 'import.failed',
        entityType: 'import_job',
        entityId: job.id,
        actorUserId: null,
        actorKind: 'SYSTEM',
        metadata: { reason: code },
      });
  });
  return 'failed';
}

/** Outcome when a step finds the job moved on under it (cancelled, expired, re-mapped…). */
async function settled(job: Job): Promise<ProcessOutcome> {
  const now = await readJob(job.orgId, job.id);
  if (now?.status === 'CANCELLED') return 'cancelled';
  if (now?.status === 'PAUSED') return 'paused';
  if (now?.status === 'FAILED' || now?.status === 'EXPIRED') return 'failed';
  return 'noop';
}

// ---------------------------------------------------------------------------------------------
// The file

type Loaded = { ok: true; parsed: ParsedFile; sha: Buffer } | { ok: false; code: string };

/**
 * Downloads at most the announced size, then checks: exact size, the hash recorded at analysis
 * (the object cannot be swapped between steps), the byte-level safety checks, and the parse.
 */
async function loadFile(job: Job, limits: ImportLimits, deps: ProcessDeps): Promise<Loaded> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.storage.download(job.storageKey, Number(job.byteSize));
  } catch (e) {
    if (e instanceof StorageError && e.code === 'NOT_FOUND')
      return { ok: false, code: 'FILE_MISSING' };
    if (e instanceof StorageError && e.code === 'TOO_LARGE')
      return { ok: false, code: 'UPLOAD_SIZE_MISMATCH' };
    throw e; // transient: the queue retries
  }
  if (bytes.byteLength !== Number(job.byteSize)) return { ok: false, code: 'UPLOAD_SIZE_MISMATCH' };
  const sha = createHash('sha256').update(bytes).digest();
  if (job.sha256 && !sha.equals(Buffer.from(job.sha256)))
    return { ok: false, code: 'FILE_CHANGED' };
  const inspected = inspectFileBytes(bytes, job.fileType as ImportFileType, limits);
  if (!inspected.ok) return { ok: false, code: inspected.code };
  const parsed = await parseImportFile(
    bytes,
    job.fileType as ImportFileType,
    limits,
    job.sheetName,
  );
  if (!parsed.ok) return { ok: false, code: parsed.code };
  return { ok: true, parsed: parsed.value, sha };
}

// ---------------------------------------------------------------------------------------------
// Analyse

async function analyse(job: Job, deps: ProcessDeps): Promise<ProcessOutcome> {
  const limits = deps.limits ?? importLimits(serverEnv().IMPORT_MAX_BYTES);
  const ctx = await uploaderContext(job.orgId, job.createdBy);
  if (!ctx) return failJob(job, 'UPLOADER_NOT_AUTHORIZED');
  if (job.status === 'UPLOADED') {
    const moved = await tenantRunner().withTenant(ctx.tenant, (tx) =>
      tx.importJob.updateMany({
        where: { id: job.id, status: 'UPLOADED' },
        data: { status: 'ANALYSING', updatedAt: new Date(), purgeFileAfter: hoursFromNow(3) },
      }),
    );
    if (moved.count !== 1) return settled(job);
  }
  // A new sheet choice re-analyses the same stored file: its hash must not change.
  const file = await loadFile({ ...job, sheetName: job.sheetName }, limits, deps);
  if (!file.ok) return failJob(job, file.code);
  const headerCheck = checkHeaders(file.parsed.headers, limits);
  if (headerCheck.fatal.length) return failJob(job, headerCheck.fatal[0]!.code);

  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const sha = new Uint8Array(file.sha);
    const earlier = await tx.importJob.findFirst({
      where: {
        sha256: sha,
        id: { not: job.id },
        status: { in: ['IMPORTING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_ERRORS'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    // Active custom fields can be suggested from matching headers too (M5).
    const custom = await tx.customFieldDefinition.findMany({
      where: { archivedAt: null },
      select: { key: true, label: true, required: true },
    });
    const r = await tx.importJob.updateMany({
      where: { id: job.id, status: 'ANALYSING' },
      data: {
        status: 'NEEDS_MAPPING',
        sha256: sha,
        sheetNames: file.parsed.sheetNames,
        sheetName: file.parsed.sheetName,
        headers: file.parsed.headers,
        rowsTotal: file.parsed.rows.length,
        mapping: suggestMapping(file.parsed.headers, custom),
        duplicateOfJobId: earlier?.id ?? null,
        errorCode: null,
        updatedAt: new Date(),
        purgeFileAfter: hoursFromNow(3),
        version: { increment: 1 },
      },
    });
    return r.count === 1 ? 'needs_mapping' : 'noop';
  });
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * HOURS);
/**
 * How long a finished or paused job keeps its file. Just under the 24 h that the
 * bounded_retention policy allows (measured from the transaction's start, not this clock).
 */
const KEEP_FILE_HOURS = 23.9;

// ---------------------------------------------------------------------------------------------
// Row plan (shared by validation and import; deterministic for a file + mapping + sources)

type Planned =
  | { row: number; kind: 'EMPTY' }
  | { row: number; kind: 'INVALID'; issues: RowIssue[] }
  | { row: number; kind: 'DUPLICATE_IN_FILE'; first: number }
  | {
      row: number;
      kind: 'VALID';
      lead: leads.PreparedLead;
      sourceId: string;
      customFields: Record<string, unknown>;
    };

async function planRows(tx: Tx, job: Job, parsed: ParsedFile, limits: ImportLimits) {
  const sources = await tx.leadSource.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });
  const ctx = {
    sourcesByName: new Map(sources.map((s) => [leads.sourceKey(s.name), s.id])),
    defaultSourceId: job.defaultSourceId!,
    limits,
    // M5: the org's custom fields, validated per row like manual create (required included).
    customFields: await leads.lockedDefinitions(tx),
  };
  const mapping = (job.mapping ?? {}) as ColumnMapping;
  const dups = new InFileDuplicates();
  return parsed.rows.map((cells, i): Planned => {
    const row = parsed.headerRow + 1 + i;
    const r = validateRow(cells, row, mapping, ctx);
    if (r.status === 'EMPTY') return { row, kind: 'EMPTY' };
    if (r.status === 'INVALID') return { row, kind: 'INVALID', issues: r.issues };
    const first = dups.check(row, r.lead.phones);
    if (first !== null) return { row, kind: 'DUPLICATE_IN_FILE', first };
    return {
      row,
      kind: 'VALID',
      lead: r.lead,
      sourceId: r.sourceId,
      customFields: r.customFields,
    };
  });
}

interface ResultRow {
  rowNumber: number;
  outcome: 'INVALID' | 'DUPLICATE_IN_FILE' | 'DUPLICATE_ATTACHED' | 'DUPLICATE_SKIPPED' | 'FAILED';
  field: string | null;
  code: string;
  relatedRow?: number | null;
  leadId?: string | null;
}

async function writeResults(tx: Tx, job: Job, phase: 'VALIDATE' | 'IMPORT', rows: ResultRow[]) {
  for (let i = 0; i < rows.length; i += RESULT_CHUNK)
    await tx.importRowResult.createMany({
      data: rows.slice(i, i + RESULT_CHUNK).map((r) => ({
        orgId: job.orgId,
        importJobId: job.id,
        phase,
        attempt: job.validationAttempt,
        rowNumber: r.rowNumber,
        outcome: r.outcome,
        field: r.field,
        code: r.code,
        relatedRow: r.relatedRow ?? null,
        leadId: r.leadId ?? null,
      })),
      skipDuplicates: true,
    });
}

// ---------------------------------------------------------------------------------------------
// Validate (dry run of every row)

async function validate(job: Job, deps: ProcessDeps): Promise<ProcessOutcome> {
  const limits = deps.limits ?? importLimits(serverEnv().IMPORT_MAX_BYTES);
  const ctx = await uploaderContext(job.orgId, job.createdBy);
  if (!ctx) return failJob(job, 'UPLOADER_NOT_AUTHORIZED');
  const file = await loadFile(job, limits, deps);
  if (!file.ok) return failJob(job, file.code);
  if (file.parsed.headers.join('\u0000') !== job.headers.join('\u0000'))
    return failJob(job, 'FILE_CHANGED');

  try {
    return await tenantRunner().withTenant(
      ctx.tenant,
      async (tx) => {
        const plan = await planRows(tx, job, file.parsed, limits);
        const valid = plan.filter((p) => p.kind === 'VALID');
        const matches = await leads.openLeadsByPhone(
          tx,
          valid.flatMap((p) => p.lead.phones),
        );
        const results: ResultRow[] = [];
        const counts = { empty: 0, valid: 0, invalid: 0, duplicateInFile: 0 };
        for (const p of plan) {
          if (p.kind === 'EMPTY') counts.empty++;
          else if (p.kind === 'INVALID') {
            counts.invalid++;
            for (const i of p.issues.slice(0, MAX_ISSUES_PER_ROW))
              results.push({ rowNumber: p.row, outcome: 'INVALID', field: i.field, code: i.code });
          } else if (p.kind === 'DUPLICATE_IN_FILE') {
            counts.duplicateInFile++;
            results.push({
              rowNumber: p.row,
              outcome: 'DUPLICATE_IN_FILE',
              field: 'primaryPhone',
              code: 'DUPLICATE_IN_FILE',
              relatedRow: p.first,
            });
          } else {
            counts.valid++;
            const leadId = p.lead.phones.map((ph) => matches.get(ph)).find(Boolean);
            if (leadId)
              results.push({
                rowNumber: p.row,
                outcome:
                  job.duplicatePolicy === 'SKIP' ? 'DUPLICATE_SKIPPED' : 'DUPLICATE_ATTACHED',
                field: 'primaryPhone',
                code: 'EXISTING_LEAD',
                leadId,
              });
          }
        }
        await writeResults(tx, job, 'VALIDATE', results);
        const now = new Date();
        const r = await tx.importJob.updateMany({
          where: { id: job.id, status: 'VALIDATING', validationAttempt: job.validationAttempt },
          data: {
            status: 'READY',
            rowsTotal: plan.length,
            rowsEmpty: counts.empty,
            rowsValid: counts.valid,
            rowsInvalid: counts.invalid,
            rowsDuplicateInFile: counts.duplicateInFile,
            validatedAt: now,
            updatedAt: now,
            purgeFileAfter: hoursFromNow(3),
            version: { increment: 1 },
          },
        });
        if (r.count !== 1) throw new Moved();
        if (!job.dryRun) return 'ready' as const;
        // A dry run ends here: it never reaches IMPORTING (also enforced by import_job CHECKs).
        await tx.importJob.updateMany({
          where: { id: job.id, status: 'READY', dryRun: true },
          data: {
            status: 'COMPLETED',
            finishedAt: now,
            purgeFileAfter: now,
            version: { increment: 1 },
          },
        });
        await writeAudit(tx, job.orgId, {
          action: 'import.dry_run_completed',
          entityType: 'import_job',
          entityId: job.id,
          actorUserId: ctx.userId,
          metadata: { valid: counts.valid, invalid: counts.invalid },
        });
        return 'dry_run_completed' as const;
      },
      { timeout: 120_000 },
    );
  } catch (e) {
    // Cancelled or re-mapped while validating: the results policy or the final
    // compare-and-set refused; nothing of this pass was kept.
    if (e instanceof Moved || isPolicyRefusal(e)) return settled(job);
    throw e;
  }
}

class Moved extends Error {}

const isPolicyRefusal = (e: unknown) =>
  e instanceof Error && /row-level security|import job .* (is finished|cannot go)/.test(e.message);

// ---------------------------------------------------------------------------------------------
// Import (batches, as the uploader)

async function importRows(first: Job, deps: ProcessDeps): Promise<ProcessOutcome> {
  if (first.dryRun) return failJob(first, 'FILE_CHANGED'); // unreachable: CHECK import_job_attested
  const limits = deps.limits ?? importLimits(serverEnv().IMPORT_MAX_BYTES);
  const batchRows = deps.batchRows ?? limits.batchRows;
  let plan: Planned[] | null = null;
  for (let batch = 0; ; batch++) {
    const job = await readJob(first.orgId, first.id);
    if (!job || job.status !== 'IMPORTING') return job ? settled(job) : 'noop';

    // Authorisation before every batch. Lost → pause; nothing is written as anyone else.
    const ctx = await uploaderContext(job.orgId, job.createdBy);
    if (!ctx) return pause(job);

    if (!plan) {
      const file = await loadFile(job, limits, deps);
      if (!file.ok) return failJob(job, file.code);
      plan = await tenantRunner().withTenant(ctx.tenant, (tx) =>
        planRows(tx, job, file.parsed, limits),
      );
      if (plan.length !== job.rowsTotal) return failJob(job, 'FILE_CHANGED');
    }
    if (job.nextRow >= plan.length) return complete(job, ctx);

    const start = job.nextRow;
    const slice = plan.slice(start, Math.min(start + batchRows, plan.length));
    try {
      const done = await tenantRunner().withTenant(
        ctx.tenant,
        (tx) => commitBatch(tx, job, ctx, slice, start, batch, deps),
        { timeout: 60_000 },
      );
      if (!done) return settled(job);
    } catch (e) {
      // Target or team can no longer receive leads (re-checked per batch by the assigner).
      if (e instanceof DomainError) return failJob(job, 'ASSIGNMENT_INVALID', ['IMPORTING']);
      throw e;
    }
    await deps.afterBatch?.(batch);
  }
}

/** One batch: locked cursor check, leads, row results and progress in a single transaction. */
async function commitBatch(
  tx: Tx,
  job: Job,
  ctx: Member,
  slice: Planned[],
  start: number,
  batch: number,
  deps: ProcessDeps,
): Promise<boolean> {
  const [locked] = await tx.$queryRaw<{ status: string; next_row: number }[]>`
    SELECT status, next_row FROM import_job WHERE id = ${job.id}::uuid FOR UPDATE`;
  if (!locked || locked.status !== 'IMPORTING' || locked.next_row !== start) return false;

  // Rows validation already reported (invalid, in-file duplicate) are not reported again.
  const reported = new Set(
    (
      await tx.importRowResult.findMany({
        where: {
          importJobId: job.id,
          phase: 'VALIDATE',
          attempt: job.validationAttempt,
          outcome: { in: ['INVALID', 'DUPLICATE_IN_FILE'] },
          rowNumber: { gte: slice[0]!.row, lte: slice[slice.length - 1]!.row },
        },
        select: { rowNumber: true },
      })
    ).map((r) => r.rowNumber),
  );
  const active = new Set(
    (await tx.leadSource.findMany({ where: { isActive: true }, select: { id: true } })).map(
      (s) => s.id,
    ),
  );
  const inputs: leads.ImportRowInput[] = [];
  const results: ResultRow[] = [];
  for (const p of slice) {
    if (p.kind === 'VALID') {
      if (active.has(p.sourceId))
        inputs.push({
          row: p.row,
          lead: p.lead,
          sourceId: p.sourceId,
          customFields: p.customFields,
        });
      else
        results.push({
          rowNumber: p.row,
          outcome: 'FAILED',
          field: 'source',
          code: 'SOURCE_INACTIVE',
        });
    } else if (p.kind !== 'EMPTY' && !reported.has(p.row)) {
      // Valid when checked, not any more (e.g. its source was renamed): reported as failed.
      const issue = p.kind === 'INVALID' ? p.issues[0]! : null;
      results.push({
        rowNumber: p.row,
        outcome: 'FAILED',
        field: issue?.field ?? 'primaryPhone',
        code: issue?.code ?? 'DUPLICATE_IN_FILE',
      });
    }
  }
  const outcomes = await leads.commitImportBatch(tx, ctx, inputs, {
    importId: job.id,
    duplicatePolicy: job.duplicatePolicy as 'ATTACH' | 'SKIP',
    assignment: job.assignment,
    strategy: deps.commitStrategy ?? 'set',
  });
  const n = { created: 0, attached: 0, skipped: 0 };
  for (const o of outcomes) {
    if (o.outcome === 'CREATED') n.created++;
    else if (o.outcome === 'ATTACHED') {
      n.attached++;
      results.push({
        rowNumber: o.row,
        outcome: 'DUPLICATE_ATTACHED',
        field: 'primaryPhone',
        code: 'EXISTING_LEAD',
        leadId: o.leadId,
      });
    } else if (o.outcome === 'FAILED') {
      // Custom fields no longer valid at commit (definitions changed since validation).
      results.push({ rowNumber: o.row, outcome: 'FAILED', field: o.field, code: o.code });
    } else if (o.outcome === 'SKIPPED_DUPLICATE') {
      n.skipped++;
      results.push({
        rowNumber: o.row,
        outcome: 'DUPLICATE_SKIPPED',
        field: 'primaryPhone',
        code: 'EXISTING_LEAD',
        leadId: o.leadId,
      });
    }
    // ALREADY_IMPORTED: committed with an earlier cursor; atomic batches make it unreachable,
    // and counting it again would double-count.
  }
  await writeResults(tx, job, 'IMPORT', results);
  await deps.inBatch?.(batch);
  await tx.importJob.update({
    where: { id: job.id },
    data: {
      nextRow: start + slice.length,
      rowsCreated: { increment: n.created },
      rowsAttached: { increment: n.attached },
      rowsSkipped: { increment: n.skipped },
      rowsFailed: { increment: results.filter((r) => r.outcome === 'FAILED').length },
      updatedAt: new Date(),
      purgeFileAfter: hoursFromNow(3),
      version: { increment: 1 },
    },
  });
  return true;
}

async function pause(job: Job): Promise<ProcessOutcome> {
  await tenantRunner().withTenant(system(job.orgId), async (tx) => {
    const r = await tx.importJob.updateMany({
      where: { id: job.id, status: 'IMPORTING' },
      data: {
        status: 'PAUSED',
        errorCode: 'UPLOADER_NOT_AUTHORIZED',
        updatedAt: new Date(),
        // A day to restore the uploader's access before the file is deleted.
        purgeFileAfter: hoursFromNow(KEEP_FILE_HOURS),
        version: { increment: 1 },
      },
    });
    if (r.count === 1)
      await writeAudit(tx, job.orgId, {
        action: 'import.paused',
        entityType: 'import_job',
        entityId: job.id,
        actorUserId: null,
        actorKind: 'SYSTEM',
        metadata: { reason: 'UPLOADER_NOT_AUTHORIZED', rowsDone: job.nextRow },
      });
  });
  return settled(job);
}

async function complete(job: Job, ctx: Member): Promise<ProcessOutcome> {
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const j = await tx.importJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { rowsInvalid: true, rowsFailed: true, rowsCreated: true, rowsAttached: true },
    });
    const now = new Date();
    const status = j.rowsInvalid + j.rowsFailed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
    const r = await tx.importJob.updateMany({
      where: { id: job.id, status: 'IMPORTING', nextRow: job.rowsTotal },
      data: {
        status,
        finishedAt: now,
        updatedAt: now,
        // The file is kept a day for questions about the results, then deleted (runbook §6).
        purgeFileAfter: hoursFromNow(KEEP_FILE_HOURS),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) return 'noop' as const;
    await writeAudit(tx, job.orgId, {
      action: 'import.completed',
      entityType: 'import_job',
      entityId: job.id,
      actorUserId: ctx.userId,
      metadata: {
        created: j.rowsCreated,
        attached: j.rowsAttached,
        failed: j.rowsFailed,
        invalid: j.rowsInvalid,
      },
    });
    return 'completed' as const;
  });
}
