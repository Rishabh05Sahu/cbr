import type { ImportStatus } from '@/modules/imports';

export const STATUS_LABELS: Record<ImportStatus, string> = {
  AWAITING_UPLOAD: 'Waiting for upload',
  UPLOADED: 'Uploaded',
  ANALYSING: 'Reading file',
  NEEDS_MAPPING: 'Map columns',
  VALIDATING: 'Checking rows',
  READY: 'Ready to import',
  IMPORTING: 'Importing',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  COMPLETED_WITH_ERRORS: 'Completed with problems',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};

export const statusTone = (s: ImportStatus): 'neutral' | 'warn' | 'good' =>
  s === 'COMPLETED'
    ? 'good'
    : s === 'FAILED' || s === 'PAUSED' || s === 'COMPLETED_WITH_ERRORS' || s === 'EXPIRED'
      ? 'warn'
      : 'neutral';
