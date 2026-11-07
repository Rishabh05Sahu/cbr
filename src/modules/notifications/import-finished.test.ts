// Wording of the "import finished" notification (migration 0010): outcome and counts only.
import { describe, expect, it } from 'vitest';
import { importFinishedText } from './index';

const job = (o: Partial<Parameters<typeof importFinishedText>[0]>) => ({
  status: 'COMPLETED',
  dryRun: false,
  rowsValid: 0,
  rowsInvalid: 0,
  rowsDuplicateInFile: 0,
  rowsCreated: 0,
  rowsAttached: 0,
  rowsSkipped: 0,
  rowsFailed: 0,
  ...o,
});

describe('importFinishedText', () => {
  it('success, with skipped rows mentioned only when there are some', () => {
    expect(importFinishedText(job({ rowsCreated: 1200, rowsAttached: 3 }))).toEqual({
      title: 'Your import finished',
      body: '1,200 new, 3 added to existing leads.',
    });
    expect(importFinishedText(job({ rowsCreated: 1, rowsSkipped: 2 }))!.body).toBe(
      '1 new, 0 added to existing leads, 2 skipped.',
    );
  });

  it('row problems count invalid and failed rows', () => {
    expect(
      importFinishedText(
        job({ status: 'COMPLETED_WITH_ERRORS', rowsCreated: 5, rowsInvalid: 2, rowsFailed: 1 }),
      ),
    ).toEqual({
      title: 'Your import finished with problems',
      body: '5 new, 0 added to existing leads. 3 rows need attention.',
    });
  });

  it('dry run and failure', () => {
    expect(importFinishedText(job({ dryRun: true, rowsValid: 4, rowsInvalid: 1 }))).toEqual({
      title: 'Your dry run finished',
      body: '4 rows would be imported; 1 needs attention. Nothing was changed.',
    });
    expect(importFinishedText(job({ status: 'FAILED' }))!.title).toBe('Your import failed');
  });

  it('nothing for a job that has not finished (or was cancelled / expired)', () => {
    for (const status of ['NEEDS_MAPPING', 'READY', 'IMPORTING', 'PAUSED', 'CANCELLED', 'EXPIRED'])
      expect(importFinishedText(job({ status }))).toBeNull();
  });
});
