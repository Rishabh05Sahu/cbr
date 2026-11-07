// Import jobs, web side (FR-040–FR-052, FR-170): start an upload, verify it, choose a sheet,
// map columns, confirm, resume, cancel, and read status and results. The worker side is
// ./processor.ts. Every command re-authorises from the server context (Owner/Admin through
// lead.import + lead.create) and works inside withTenant(), so RLS limits it to the caller's
// org; migration 0005 adds the uploader, deadline, retention and state-machine rules in SQL.
// The person who uploaded the file is the import's actor (the worker writes leads as them),
// so only they can continue it; any Owner or Admin can cancel it.
//
// Status changes are compare-and-set (`updateMany` on the expected status and version): a
// double-clicked button or a replayed request changes nothing the second time.
import { z } from 'zod';
import { serverEnv } from '@/env';
import { uuidv7 } from '@/lib/uuidv7';
import { writeAudit } from '@/modules/audit';
import * as leads from '@/modules/leads';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { conflict, DomainError, forbidden, notFound, ruleViolation } from '@/platform/errors';
import { emitEvent } from '@/platform/outbox';
import {
  importStorage,
  isStorageConfigured,
  objectKeyFor,
  type ObjectStorage,
} from '@/platform/storage';
import { checkDeclaredFile, FILE_CHECK_MESSAGES } from './file-check';
import { importLimits } from './limits';
import {
  CUSTOM_PREFIX,
  customKeyOf,
  FIELD_SPEC,
  validateMapping,
  type ColumnMapping,
  type ImportField,
} from './mapping';
import { jobErrorMessage, rowProblemMessage } from './messages';

export const IMPORT_STATUSES = [
  'AWAITING_UPLOAD',
  'UPLOADED',
  'ANALYSING',
  'NEEDS_MAPPING',
  'VALIDATING',
  'READY',
  'IMPORTING',
  'PAUSED',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);
/** The worker is (or should be) doing something: the page keeps refreshing. */
export const WORKING_STATUSES: ReadonlySet<string> = new Set([
  'UPLOADED',
  'ANALYSING',
  'VALIDATING',
  'IMPORTING',
]);

/** Uploader attestation (FR-170) shown on the confirm step; its version is stored on the job. */
export const ATTESTATION_VERSION = '2026-10-v1';
export const ATTESTATION_TEXT =
  'I confirm these contacts were collected lawfully for property enquiries, that they may be contacted about them, and that I am allowed to import them into this organisation.';
/** Uploads a user may have in flight at once (abuse limit). */
export const MAX_PENDING_UPLOADS = 5;

type Member = RequestContext & { kind: 'member' };

/** Owner/Admin with import and lead-creation rights, as an org member. */
export function requireImporter(ctx: RequestContext): Member {
  authorize(ctx, 'lead.import');
  authorize(ctx, 'lead.create');
  if (ctx.kind !== 'member') throw forbidden('Only organisation members can import leads');
  return ctx;
}

const limits = () => importLimits(serverEnv().IMPORT_MAX_BYTES);

function parseJobId(raw: unknown): string {
  const r = z.uuid().safeParse(raw);
  if (!r.success) throw notFound('Import not found');
  return r.data;
}

function storageOrFail(storage?: ObjectStorage): ObjectStorage {
  if (storage) return storage;
  if (!isStorageConfigured()) throw ruleViolation('File storage is not configured on this server');
  return importStorage();
}

const JOB_SELECT = {
  id: true,
  createdBy: true,
  status: true,
  version: true,
  fileType: true,
  contentType: true,
  byteSize: true,
  storageKey: true,
  sheetNames: true,
  sheetName: true,
  headers: true,
  dryRun: true,
  rowsValid: true,
  duplicateOfJobId: true,
  uploadExpiresAt: true,
  validationAttempt: true,
} as const;

async function loadJob(tx: Tx, id: string) {
  const job = await tx.importJob.findUnique({ where: { id }, select: JOB_SELECT });
  if (!job) throw notFound('Import not found');
  return job;
}

function mustBeUploader(ctx: Member, job: { createdBy: string }) {
  if (job.createdBy !== ctx.userId)
    throw forbidden('Only the person who uploaded this file can continue this import');
}

const stale = () =>
  conflict('This import changed in the meantime. Reload the page to see its current state.');

const requestProcessing = (tx: Tx, orgId: string, importJobId: string) =>
  emitEvent(tx, orgId, { type: 'import.process_requested', payload: { importJobId } });

// ---------------------------------------------------------------------------------------------
// Upload

const startInput = z.object({
  fileName: z.string().max(1000),
  size: z.coerce.number(),
  type: z.string().max(200),
});

export interface StartedImport {
  importId: string;
  /** Single-object, no-overwrite upload permission. Contains a token: never log or store it. */
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
  expiresAt: string;
}

/**
 * Creates the job and a signed upload permission for one server-generated key
 * (orgs/<org>/imports/<job>/<random>.<ext>). The browser PUTs the file there directly.
 */
export async function startImport(
  ctx: RequestContext,
  raw: unknown,
  storage?: ObjectStorage,
): Promise<StartedImport> {
  const me = requireImporter(ctx);
  const store = storageOrFail(storage);
  const input = startInput.parse(raw);
  const checked = checkDeclaredFile(
    { name: input.fileName, size: input.size, type: input.type },
    limits(),
  );
  if (!checked.ok) {
    const message = FILE_CHECK_MESSAGES[checked.code];
    throw new DomainError('VALIDATION_FAILED', message, { file: [message] });
  }
  const file = checked.value;
  const id = uuidv7();
  const key = objectKeyFor(me.orgId, 'imports', id, file.fileType);
  const job = await tenantRunner().withTenant(me.tenant, async (tx) => {
    const pending = await tx.importJob.count({
      where: { createdBy: me.userId, status: { in: ['AWAITING_UPLOAD', 'UPLOADED', 'ANALYSING'] } },
    });
    if (pending >= MAX_PENDING_UPLOADS)
      throw ruleViolation('Finish or cancel your other uploads before starting another one');
    const row = await tx.importJob.create({
      data: {
        id,
        orgId: me.orgId,
        createdBy: me.userId,
        fileType: file.fileType,
        contentType: file.contentType,
        originalFilename: file.displayName,
        byteSize: BigInt(input.size),
        storageKey: key,
      },
      select: { uploadExpiresAt: true },
    });
    await writeAudit(tx, me.orgId, {
      action: 'import.created',
      entityType: 'import_job',
      entityId: id,
      actorUserId: me.userId,
      metadata: { fileType: file.fileType, bytes: input.size },
    });
    return row;
  });
  try {
    const grant = await store.createUploadGrant(key, file.contentType);
    const expires = Math.min(job.uploadExpiresAt.getTime(), grant.providerExpiresAt.getTime());
    return {
      importId: id,
      upload: { url: grant.url, method: grant.method, headers: grant.headers },
      expiresAt: new Date(expires).toISOString(),
    };
  } catch {
    await tenantRunner().withTenant(me.tenant, (tx) =>
      finish(tx, id, ['AWAITING_UPLOAD'], 'FAILED', 'STORAGE_UNAVAILABLE'),
    );
    throw ruleViolation(jobErrorMessage('STORAGE_UNAVAILABLE')!);
  }
}

/** Ends a job (compare-and-set). The file is deleted by the next cleanup sweep. */
async function finish(
  tx: Tx,
  id: string,
  from: readonly string[],
  status: 'FAILED' | 'CANCELLED' | 'EXPIRED',
  errorCode: string | null,
): Promise<boolean> {
  const now = new Date();
  const r = await tx.importJob.updateMany({
    where: { id, status: { in: [...from] } },
    data: {
      status,
      errorCode,
      finishedAt: now,
      purgeFileAfter: now,
      updatedAt: now,
      version: { increment: 1 },
      ...(status === 'CANCELLED' ? { cancelRequestedAt: now } : {}),
    },
  });
  return r.count === 1;
}

/**
 * Called by the browser after its PUT. Verifies the object exists with exactly the announced
 * size and the granted type before anything reads it; the worker later re-checks the size and
 * the content itself. Safe to call twice.
 */
export async function confirmUpload(
  ctx: RequestContext,
  rawId: unknown,
  storage?: ObjectStorage,
): Promise<{ status: string }> {
  const me = requireImporter(ctx);
  const id = parseJobId(rawId);
  const store = storageOrFail(storage);
  const job = await tenantRunner().withTenant(me.tenant, (tx) => loadJob(tx, id));
  mustBeUploader(me, job);
  if (job.status !== 'AWAITING_UPLOAD') {
    if (TERMINAL_STATUSES.has(job.status)) throw ruleViolation('This import has already ended');
    return { status: job.status };
  }
  const fail = async (status: 'FAILED' | 'EXPIRED', code: string) => {
    await tenantRunner().withTenant(me.tenant, (tx) =>
      finish(tx, id, ['AWAITING_UPLOAD'], status, code),
    );
    throw ruleViolation(jobErrorMessage(code)!);
  };
  if (job.uploadExpiresAt.getTime() <= Date.now()) await fail('EXPIRED', 'FILE_EXPIRED');

  let meta;
  try {
    meta = await store.stat(job.storageKey);
  } catch {
    throw ruleViolation(jobErrorMessage('STORAGE_UNAVAILABLE')!);
  }
  // Not there (yet): the job stays open so the browser can retry the PUT.
  if (!meta) throw ruleViolation(jobErrorMessage('UPLOAD_MISSING')!);
  const type = meta.contentType?.split(';')[0]?.trim().toLowerCase() ?? null;
  if (meta.size !== Number(job.byteSize)) await fail('FAILED', 'UPLOAD_SIZE_MISMATCH');
  if (type !== job.contentType) await fail('FAILED', 'UPLOAD_TYPE_MISMATCH');

  return tenantRunner().withTenant(me.tenant, async (tx) => {
    const now = new Date();
    const r = await tx.importJob.updateMany({
      where: { id, status: 'AWAITING_UPLOAD' },
      data: {
        status: 'UPLOADED',
        uploadedAt: now,
        updatedAt: now,
        purgeFileAfter: new Date(now.getTime() + 3 * 3600_000),
        version: { increment: 1 },
      },
    });
    if (r.count === 1) await requestProcessing(tx, me.orgId, id);
    return { status: 'UPLOADED' };
  });
}

// ---------------------------------------------------------------------------------------------
// Sheet, mapping and options

/** Reads the chosen worksheet instead (OD-08). The mapping starts again from suggestions. */
export async function chooseSheet(
  ctx: RequestContext,
  rawId: unknown,
  raw: unknown,
): Promise<void> {
  const me = requireImporter(ctx);
  const id = parseJobId(rawId);
  const { sheet, version } = z
    .object({ sheet: z.string().max(100), version: z.coerce.number().int() })
    .parse(raw);
  await tenantRunner().withTenant(me.tenant, async (tx) => {
    const job = await loadJob(tx, id);
    mustBeUploader(me, job);
    if (!job.sheetNames.includes(sheet)) throw notFound('That worksheet is not in the file');
    if (job.version !== version) throw stale();
    if (job.status === 'READY')
      await tx.importJob.updateMany({
        where: { id, status: 'READY', version },
        data: { status: 'NEEDS_MAPPING' },
      });
    const r = await tx.importJob.updateMany({
      where: { id, status: 'NEEDS_MAPPING', version },
      data: {
        status: 'ANALYSING',
        sheetName: sheet,
        mapping: {},
        headers: [],
        updatedAt: new Date(),
        purgeFileAfter: new Date(Date.now() + 3 * 3600_000),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw stale();
    await requestProcessing(tx, me.orgId, id);
  });
}

const mappingInput = z.object({
  mapping: z.record(z.string(), z.unknown()),
  defaultSourceId: z.union([z.uuid(), z.literal('')]).optional(),
  duplicatePolicy: z.enum(['ATTACH', 'SKIP']),
  assignment: z.unknown(),
  dryRun: z.boolean(),
  version: z.coerce.number().int(),
});

/**
 * Saves the mapping and options and starts validation (a dry run of every row, writing only
 * row results). The assignment plan is checked as the uploader would run it.
 */
export async function submitMapping(ctx: RequestContext, rawId: unknown, raw: unknown) {
  const me = requireImporter(ctx);
  const id = parseJobId(rawId);
  const input = mappingInput.parse(raw);
  const assignment = leads.importAssignmentSchema.parse(input.assignment);
  const job = await tenantRunner().withTenant(me.tenant, (tx) => loadJob(tx, id));
  mustBeUploader(me, job);
  if (job.status !== 'NEEDS_MAPPING' && job.status !== 'READY')
    throw ruleViolation('The columns can only be mapped before the import starts');
  if (job.version !== input.version) throw stale();
  // M5: the org's ACTIVE custom fields can be mapped; required ones must be.
  const custom = await tenantRunner().withTenant(me.tenant, (tx) =>
    tx.customFieldDefinition.findMany({
      where: { archivedAt: null },
      select: { key: true, label: true, required: true },
    }),
  );
  const mapping = validateMapping(input.mapping, job.headers.length, custom);
  if (!mapping.ok) {
    const fieldErrors: Record<string, string[]> = {};
    for (const i of mapping.issues) {
      const ck = i.field ? customKeyOf(i.field) : null;
      const label =
        (ck !== null
          ? custom.find((c) => c.key === ck)?.label
          : i.field && FIELD_SPEC.get(i.field as ImportField)?.label) ?? 'Mapping';
      (fieldErrors[label] ??= []).push(MAPPING_MESSAGES[i.code] ?? 'is not valid');
    }
    throw new DomainError('VALIDATION_FAILED', 'Please check the column mapping', fieldErrors);
  }
  await leads.checkImportAssignment(me, assignment);

  await tenantRunner().withTenant(me.tenant, async (tx) => {
    let sourceId: string;
    if (input.defaultSourceId) {
      const s = await tx.leadSource.findFirst({
        where: { id: input.defaultSourceId, isActive: true },
        select: { id: true },
      });
      if (!s) throw new DomainError('VALIDATION_FAILED', 'Choose an active lead source');
      sourceId = s.id;
    } else sourceId = await leads.unknownSourceId(tx, me.orgId);
    const now = new Date();
    const r = await tx.importJob.updateMany({
      where: { id, status: { in: ['NEEDS_MAPPING', 'READY'] }, version: input.version },
      data: {
        status: 'VALIDATING',
        mapping: mapping.mapping,
        defaultSourceId: sourceId,
        duplicatePolicy: input.duplicatePolicy,
        assignment,
        dryRun: input.dryRun,
        validationAttempt: { increment: 1 },
        validatedAt: null,
        rowsEmpty: 0,
        rowsValid: 0,
        rowsInvalid: 0,
        rowsDuplicateInFile: 0,
        errorCode: null,
        updatedAt: now,
        purgeFileAfter: new Date(now.getTime() + 3 * 3600_000),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw stale();
    await requestProcessing(tx, me.orgId, id);
  });
}

const MAPPING_MESSAGES: Record<string, string> = {
  FIELD_UNKNOWN: 'is not a field that can be imported',
  COLUMN_INVALID: 'points to a column that is not in the file',
  COLUMN_MAPPED_TWICE: 'uses a column that is already mapped to another field',
  REQUIRED_UNMAPPED: 'must be mapped to a column',
};

// ---------------------------------------------------------------------------------------------
// Confirm, resume, cancel

const confirmInput = z.object({
  attest: z.literal(true, { error: 'Confirm that you may import these contacts' }),
  acknowledgeDuplicateFile: z.boolean().optional(),
  version: z.coerce.number().int(),
});

/** Starts writing leads, as the uploader, after their attestation (FR-170). */
export async function confirmImport(ctx: RequestContext, rawId: unknown, raw: unknown) {
  const me = requireImporter(ctx);
  const id = parseJobId(rawId);
  const input = confirmInput.parse(raw);
  const job = await tenantRunner().withTenant(me.tenant, (tx) =>
    tx.importJob.findUnique({
      where: { id },
      select: { ...JOB_SELECT, assignment: true },
    }),
  );
  if (!job) throw notFound('Import not found');
  mustBeUploader(me, job);
  if (job.status !== 'READY') throw ruleViolation('This import is not waiting for confirmation');
  if (job.version !== input.version) throw stale();
  if (job.dryRun) throw ruleViolation('A dry run never imports. Start a new import to import.');
  if (job.rowsValid === 0) throw ruleViolation('There are no valid rows to import');
  if (job.duplicateOfJobId && !input.acknowledgeDuplicateFile)
    throw ruleViolation('This file was imported before. Confirm that you want to import it again.');
  await leads.checkImportAssignment(me, job.assignment);
  try {
    await tenantRunner().withTenant(me.tenant, async (tx) => {
      const now = new Date();
      const r = await tx.importJob.updateMany({
        where: { id, status: 'READY', version: input.version, dryRun: false },
        data: {
          status: 'IMPORTING',
          attestedAt: now,
          attestationVersion: ATTESTATION_VERSION,
          hashWarningAckAt: job.duplicateOfJobId ? now : null,
          startedAt: now,
          updatedAt: now,
          purgeFileAfter: new Date(now.getTime() + 3 * 3600_000),
          version: { increment: 1 },
        },
      });
      if (r.count !== 1) throw stale();
      await writeAudit(tx, me.orgId, {
        action: 'import.confirmed',
        entityType: 'import_job',
        entityId: id,
        actorUserId: me.userId,
        metadata: { rows: job.rowsValid, attestation: ATTESTATION_VERSION },
      });
      await requestProcessing(tx, me.orgId, id);
    });
  } catch (e) {
    if (e instanceof Error && /import_job_one_running_uq/.test(e.message))
      throw conflict(
        'Another import is running or paused in this organisation. Wait for it to finish or cancel it.',
      );
    throw e;
  }
}

/**
 * Continues a paused import. Only the uploader can resume, and only with a currently valid
 * Owner/Admin context (requireImporter on this request); the worker checks again per batch.
 */
export async function resumeImport(ctx: RequestContext, rawId: unknown) {
  const me = requireImporter(ctx);
  const id = parseJobId(rawId);
  await tenantRunner().withTenant(me.tenant, async (tx) => {
    const job = await loadJob(tx, id);
    mustBeUploader(me, job);
    if (job.status !== 'PAUSED') throw ruleViolation('This import is not paused');
    const now = new Date();
    const r = await tx.importJob.updateMany({
      where: { id, status: 'PAUSED' },
      data: {
        status: 'IMPORTING',
        errorCode: null,
        updatedAt: now,
        purgeFileAfter: new Date(now.getTime() + 3 * 3600_000),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw stale();
    await writeAudit(tx, me.orgId, {
      action: 'import.resumed',
      entityType: 'import_job',
      entityId: id,
      actorUserId: me.userId,
    });
    await requestProcessing(tx, me.orgId, id);
  });
}

/**
 * Any Owner or Admin can cancel an unfinished import (e.g. one paused because its uploader left).
 * A running batch finishes first (it holds the job row lock); nothing after it is written.
 * Leads already imported stay.
 */
export async function cancelImport(ctx: RequestContext, rawId: unknown) {
  const me = requireImporter(ctx);
  const id = parseJobId(rawId);
  await tenantRunner().withTenant(me.tenant, async (tx) => {
    const job = await loadJob(tx, id);
    if (TERMINAL_STATUSES.has(job.status)) throw ruleViolation('This import has already ended');
    const open = IMPORT_STATUSES.filter((s) => !TERMINAL_STATUSES.has(s));
    if (!(await finish(tx, id, open, 'CANCELLED', null))) throw stale();
    await writeAudit(tx, me.orgId, {
      action: 'import.cancelled',
      entityType: 'import_job',
      entityId: id,
      actorUserId: me.userId,
      metadata: { from: job.status },
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Reads

export interface ImportCounts {
  total: number;
  empty: number;
  valid: number;
  invalid: number;
  duplicateInFile: number;
  created: number;
  attached: number;
  skipped: number;
  failed: number;
  processed: number;
  /** Validation preview: valid rows that match an open lead. */
  existingDuplicates: number;
}

export interface ImportView {
  id: string;
  status: ImportStatus;
  version: number;
  fileName: string;
  fileType: string;
  bytes: number;
  createdAt: Date;
  createdByName: string;
  isUploader: boolean;
  sheetNames: string[];
  sheetName: string | null;
  headers: string[];
  mapping: ColumnMapping;
  defaultSourceId: string | null;
  duplicatePolicy: 'ATTACH' | 'SKIP';
  assignment: leads.ImportAssignment;
  dryRun: boolean;
  counts: ImportCounts;
  errorCode: string | null;
  errorMessage: string | null;
  duplicateOfJob: { id: string; createdAt: Date } | null;
  attestedAt: Date | null;
  finishedAt: Date | null;
  fileDeleted: boolean;
  uploadExpiresAt: Date;
}

export async function getImport(ctx: RequestContext, rawId: unknown): Promise<ImportView> {
  const me = requireImporter(ctx);
  const id = parseJobId(rawId);
  return tenantRunner().withTenant(me.tenant, async (tx) => {
    const j = await tx.importJob.findUnique({
      where: { id },
      include: {
        creator: { select: { user: { select: { name: true } } } },
        duplicateOf: { select: { id: true, createdAt: true } },
      },
    });
    if (!j) throw notFound('Import not found');
    const existingDuplicates = await tx.importRowResult.count({
      where: {
        importJobId: id,
        phase: 'VALIDATE',
        attempt: j.validationAttempt,
        outcome: { in: ['DUPLICATE_ATTACHED', 'DUPLICATE_SKIPPED'] },
      },
    });
    const parsedAssignment = leads.importAssignmentSchema.safeParse(j.assignment);
    return {
      id: j.id,
      status: j.status as ImportStatus,
      version: j.version,
      fileName: j.originalFilename,
      fileType: j.fileType,
      bytes: Number(j.byteSize),
      createdAt: j.createdAt,
      createdByName: j.creator.user.name,
      isUploader: j.createdBy === me.userId,
      sheetNames: j.sheetNames,
      sheetName: j.sheetName,
      headers: j.headers,
      mapping: (j.mapping ?? {}) as ColumnMapping,
      defaultSourceId: j.defaultSourceId,
      duplicatePolicy: j.duplicatePolicy as 'ATTACH' | 'SKIP',
      assignment: parsedAssignment.success ? parsedAssignment.data : { mode: 'none' },
      dryRun: j.dryRun,
      counts: {
        total: j.rowsTotal,
        empty: j.rowsEmpty,
        valid: j.rowsValid,
        invalid: j.rowsInvalid,
        duplicateInFile: j.rowsDuplicateInFile,
        created: j.rowsCreated,
        attached: j.rowsAttached,
        skipped: j.rowsSkipped,
        failed: j.rowsFailed,
        processed: j.nextRow,
        existingDuplicates,
      },
      errorCode: j.errorCode,
      errorMessage: jobErrorMessage(j.errorCode),
      duplicateOfJob: j.duplicateOf,
      attestedAt: j.attestedAt,
      finishedAt: j.finishedAt,
      fileDeleted: j.fileDeletedAt !== null,
      uploadExpiresAt: j.uploadExpiresAt,
    };
  });
}

export interface ImportSummary {
  id: string;
  status: ImportStatus;
  fileName: string;
  createdAt: Date;
  createdByName: string;
  created: number;
  attached: number;
  total: number;
}

export async function listImports(ctx: RequestContext, limit = 20): Promise<ImportSummary[]> {
  const me = requireImporter(ctx);
  return tenantRunner().withTenant(me.tenant, async (tx) => {
    const rows = await tx.importJob.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(1, limit), 100),
      select: {
        id: true,
        status: true,
        originalFilename: true,
        createdAt: true,
        rowsCreated: true,
        rowsAttached: true,
        rowsTotal: true,
        creator: { select: { user: { select: { name: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status as ImportStatus,
      fileName: r.originalFilename,
      createdAt: r.createdAt,
      createdByName: r.creator.user.name,
      created: r.rowsCreated,
      attached: r.rowsAttached,
      total: r.rowsTotal,
    }));
  });
}

export interface ImportIssue {
  row: number;
  /** Column heading from the file, when the problem is about a mapped field. */
  column: string | null;
  field: string | null;
  fieldLabel: string | null;
  outcome: string;
  code: string;
  message: string;
  relatedRow: number | null;
  leadId: string | null;
}

/**
 * Row problems and duplicate matches of the current validation pass and of the import, in row
 * order. Codes, field names and column headings only: never cell values.
 */
export async function listImportIssues(
  ctx: RequestContext,
  rawId: unknown,
  opts: { offset?: number; limit?: number } = {},
): Promise<{ issues: ImportIssue[]; total: number }> {
  const me = requireImporter(ctx);
  const id = parseJobId(rawId);
  return tenantRunner().withTenant(me.tenant, async (tx) => {
    const job = await tx.importJob.findUnique({
      where: { id },
      select: { headers: true, mapping: true, validationAttempt: true },
    });
    if (!job) throw notFound('Import not found');
    const where = { importJobId: id, attempt: job.validationAttempt };
    const [rows, total] = await Promise.all([
      tx.importRowResult.findMany({
        where,
        orderBy: [{ rowNumber: 'asc' }, { phase: 'asc' }, { id: 'asc' }],
        skip: Math.max(0, opts.offset ?? 0),
        take: Math.min(Math.max(1, opts.limit ?? 100), 10_000),
        select: {
          rowNumber: true,
          field: true,
          outcome: true,
          code: true,
          relatedRow: true,
          leadId: true,
        },
      }),
      tx.importRowResult.count({ where }),
    ]);
    const mapping = (job.mapping ?? {}) as ColumnMapping;
    const customLabels = new Map(
      (await tx.customFieldDefinition.findMany({ select: { key: true, label: true } })).map((c) => [
        c.key,
        c.label,
      ]),
    );
    return {
      total,
      issues: rows.map((r) => {
        const spec = r.field ? FIELD_SPEC.get(r.field as ImportField) : undefined;
        const customKey = r.field ? leads.customKeyFromIssueField(r.field) : null;
        const column = spec
          ? mapping[spec.field]
          : customKey !== null
            ? mapping[`${CUSTOM_PREFIX}${customKey}`]
            : undefined;
        return {
          row: r.rowNumber,
          column: column !== undefined ? (job.headers[column] ?? null) : null,
          field: r.field,
          fieldLabel:
            spec?.label ?? (customKey !== null ? (customLabels.get(customKey) ?? customKey) : null),
          outcome: r.outcome,
          code: r.code,
          message: rowProblemMessage(r.code),
          relatedRow: r.relatedRow,
          leadId: r.leadId,
        };
      }),
    };
  });
}

/** Spreadsheet apps execute cells starting with these; prefix them so the CSV stays inert. */
const csvCell = (v: string | number | null) => {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** All problems as CSV (FR-047): row, column, field, problem, related row. No cell values. */
export async function importIssuesCsv(ctx: RequestContext, rawId: unknown): Promise<string> {
  const { issues } = await listImportIssues(ctx, rawId, { limit: 10_000 });
  const lines = [['Row', 'Column', 'Field', 'Outcome', 'Problem', 'Same as row', 'Existing lead']];
  for (const i of issues)
    lines.push([
      String(i.row),
      i.column ?? '',
      i.fieldLabel ?? '',
      i.outcome,
      i.message,
      i.relatedRow === null ? '' : String(i.relatedRow),
      i.leadId ?? '',
    ]);
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
