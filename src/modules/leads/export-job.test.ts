import { describe, expect, it } from 'vitest';
import {
  assertExportSize,
  downloadDeadline,
  EXPORT_MAX_BYTES,
  ExportFileTooLarge,
  EXPORT_FILTERS_MAX_BYTES,
  exportAuditFilters,
  exportAvailability,
  exportFilters,
  ExportFiltersTooLarge,
  purgeDeadline,
  withoutSearch,
  type ExportJobView,
} from './export-job';
import type { LeadQuery } from './list-query';

const T0 = new Date('2026-10-24T09:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

const query = (patch: Partial<LeadQuery> = {}): LeadQuery => ({
  q: null,
  stages: [],
  intents: [],
  propertyTypes: [],
  owner: null,
  teamId: null,
  sourceId: null,
  city: null,
  createdFrom: null,
  createdTo: null,
  assignedFrom: null,
  assignedTo: null,
  budgetFrom: null,
  budgetTo: null,
  followUpDue: null,
  archived: 'active',
  sort: 'newest',
  cursor: null,
  ...patch,
});

describe('export job rules', () => {
  it('purges one hour after creation; the window is 15 minutes, never past the purge', () => {
    expect(purgeDeadline(T0)).toEqual(min(60));
    expect(downloadDeadline(min(10), min(60))).toEqual(min(25));
    expect(downloadDeadline(min(50), min(60))).toEqual(min(60));
  });

  it('a ready job is downloadable only inside its window, once', () => {
    const ready: ExportJobView = {
      status: 'READY',
      expiresAt: min(25),
      purgeFileAfter: min(60),
      fileDeletedAt: null,
    };
    expect(exportAvailability(ready, min(24))).toBe('AVAILABLE');
    expect(exportAvailability(ready, min(25))).toBe('EXPIRED');
    expect(exportAvailability({ ...ready, fileDeletedAt: min(20) }, min(21))).toBe('EXPIRED');
    expect(exportAvailability({ ...ready, status: 'DOWNLOADED' }, min(21))).toBe('USED');
    expect(exportAvailability({ ...ready, status: 'QUEUED', expiresAt: null }, min(5))).toBe(
      'PREPARING',
    );
    expect(exportAvailability({ ...ready, status: 'RUNNING', expiresAt: null }, min(61))).toBe(
      'EXPIRED',
    );
  });

  it('stores the list filters without paging or empty values', () => {
    expect(
      exportFilters(query({ stages: ['NEW'], city: 'Pune', cursor: 'abc', sort: 'name' })),
    ).toEqual({ stages: ['NEW'], city: 'Pune', archived: 'active' });
    expect(() => exportFilters(query({ q: 'x'.repeat(EXPORT_FILTERS_MAX_BYTES) }))).toThrow(
      ExportFiltersTooLarge,
    );
  });

  it('the audit copy never contains the search text', () => {
    const f = exportFilters(query({ q: '9000000001', stages: ['NEW'] }));
    expect(exportAuditFilters(f)).toEqual({ stages: ['NEW'], archived: 'active', search: true });
    expect(JSON.stringify(exportAuditFilters(f))).not.toContain('9000000001');
  });

  it('a finished job keeps its filters without the search text', () => {
    const f = exportFilters(query({ q: 'Synthetic Lead', stages: ['NEW'] }));
    expect(withoutSearch(f)).toEqual({ stages: ['NEW'], archived: 'active' });
    expect(withoutSearch({ stages: ['NEW'] })).toEqual({ stages: ['NEW'] });
  });

  it('a file over 20 MB fails clearly instead of being cut', () => {
    expect(() => assertExportSize(EXPORT_MAX_BYTES)).not.toThrow();
    expect(() => assertExportSize(EXPORT_MAX_BYTES + 1)).toThrow(ExportFileTooLarge);
    try {
      assertExportSize(EXPORT_MAX_BYTES + 1);
    } catch (e) {
      expect((e as ExportFileTooLarge).code).toBe('EXPORT_FILE_TOO_LARGE');
    }
  });
});
