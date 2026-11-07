// Imports module (Phase 2 M4, FR-040–FR-052, FR-170): import jobs (./jobs.ts, web), the worker
// steps (./processor.ts), file cleanup (./cleanup.ts), and the file checks, parsing, mapping and
// row validation they share. Lead writes go through the leads module (commitImportBatch); files
// through @/platform/storage. Parsing runs only in the worker: ./processor.ts and ./cleanup.ts
// (and ./parse.ts, which they use) are imported by src/worker directly and are deliberately not
// re-exported here, so the web bundle never contains the spreadsheet readers.
import { serverEnv } from '@/env';
import { authorize, type RequestContext } from '@/platform/authz';
import { isStorageConfigured } from '@/platform/storage';
import { importLimits, type ImportLimits } from './limits';

export {
  checkDeclaredFile,
  CONTENT_TYPES,
  displayFileName,
  FILE_CHECK_MESSAGES,
  inspectFileBytes,
  type AcceptedFile,
  type FileCheckCode,
  type ImportFileType,
} from './file-check';
export { DEFAULT_IMPORT_LIMITS, importLimits, type ImportLimits } from './limits';
export {
  checkHeaders,
  IMPORT_FIELDS,
  suggestMapping,
  unmappedColumns,
  validateMapping,
  type ColumnMapping,
  type ImportField,
} from './mapping';
export {
  cellText,
  InFileDuplicates,
  validateRow,
  type Cell,
  type RowIssue,
  type RowResult,
} from './rows';

export {
  ATTESTATION_TEXT,
  ATTESTATION_VERSION,
  cancelImport,
  chooseSheet,
  confirmImport,
  confirmUpload,
  getImport,
  importIssuesCsv,
  IMPORT_STATUSES,
  listImportIssues,
  listImports,
  requireImporter,
  resumeImport,
  startImport,
  submitMapping,
  TERMINAL_STATUSES,
  WORKING_STATUSES,
  type ImportCounts,
  type ImportIssue,
  type ImportStatus,
  type ImportSummary,
  type ImportView,
  type StartedImport,
} from './jobs';
export { jobErrorMessage, rowProblemMessage } from './messages';
export {
  applyTemplate,
  deleteMappingTemplate,
  listMappingTemplates,
  saveMappingTemplate,
  TEMPLATE_WARNING_MESSAGES,
  templateForImport,
  templateFromMapping,
  type MappingTemplateView,
  type TemplateMapping,
  type TemplateWarning,
} from './templates';

export interface ImportReadiness {
  limits: ImportLimits;
  storageConfigured: boolean;
}

export function importReadiness(ctx: RequestContext): ImportReadiness {
  authorize(ctx, 'lead.import');
  return {
    limits: importLimits(serverEnv().IMPORT_MAX_BYTES),
    storageConfigured: isStorageConfigured(),
  };
}
