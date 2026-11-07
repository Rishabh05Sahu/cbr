// User-facing text for import codes. Job errors and row problems are stored as codes only
// (never cell values, provider messages or stack traces); these fixed strings are all the UI
// and the issues CSV ever show. This file must not import the parser (web code uses it).
import { FILE_CHECK_MESSAGES } from './file-check';
import type { ParseCode } from './parse';

/** Parser failures (./parse.ts; kept here so web code never loads the readers). */
export const PARSE_MESSAGES: Record<ParseCode, string> = {
  PARSE_FAILED: 'The file could not be read. Save it again as .xlsx or UTF-8 .csv and retry.',
  PARSE_TIMEOUT: 'The file took too long to read. Split it into smaller files.',
  SHEET_NOT_FOUND: 'That worksheet is not in the file.',
  HEADER_MISSING: 'No header row was found in the first rows of the sheet.',
  TOO_MANY_ROWS: 'The file has more rows than one import allows.',
};

const JOB_MESSAGES: Record<string, string> = {
  ...FILE_CHECK_MESSAGES,
  ...PARSE_MESSAGES,
  HEADER_MISSING: 'No header row was found in the first rows of the sheet.',
  HEADER_TOO_LONG: 'A column heading is too long.',
  TOO_MANY_COLUMNS: 'The sheet has more columns than one import allows.',
  UPLOAD_MISSING: 'The upload did not reach storage. Upload the file again.',
  UPLOAD_SIZE_MISMATCH: 'The stored file is not the file that was announced. Upload it again.',
  UPLOAD_TYPE_MISMATCH: 'The stored file type does not match. Upload it again.',
  FILE_CHANGED: 'The stored file changed after it was checked. Start a new import.',
  FILE_MISSING: 'The stored file is no longer available. Start a new import.',
  FILE_EXPIRED: 'The import was inactive for too long and its file was deleted. Start again.',
  STORAGE_UNAVAILABLE: 'File storage was unavailable. Try again shortly.',
  UPLOADER_NOT_AUTHORIZED:
    'The person who started this import is no longer an active Owner or Admin. It resumes when their access is restored, or an Owner or Admin can cancel it.',
  ASSIGNMENT_INVALID:
    'The chosen assignee or team can no longer receive leads. The rows imported so far are kept.',
  SOURCE_INACTIVE: 'A lead source used by this import was deactivated.',
  CANCELLED_BY_USER: 'The import was cancelled.',
};

export function jobErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return JOB_MESSAGES[code] ?? 'The import stopped because of an unexpected problem.';
}

const ROW_MESSAGES: Record<string, string> = {
  VALUE_REQUIRED: 'A value is required.',
  VALUE_TOO_LONG: 'The value is too long.',
  VALUE_NOT_ALLOWED: 'The value is not one of the allowed options.',
  VALUE_INVALID_FORMAT: 'The value is not in a valid format.',
  VALUE_INVALID: 'The value is not valid.',
  CELL_TOO_LONG: 'The cell is longer than allowed.',
  SOURCE_UNKNOWN:
    'No active lead source has this name. An Owner or Admin can add it under Lead sources.',
  CUSTOM_FIELD_INVALID:
    'Not a valid value for this custom field (numbers as digits, dates as YYYY-MM-DD, yes/no, an existing option; several options separated by ";").',
  CUSTOM_FIELD_REQUIRED: 'This custom field is required.',
  SOURCE_INACTIVE: 'The lead source was deactivated before this row was imported.',
  PHONE_REQUIRED: 'A phone number is required.',
  PHONE_INVALID_CHARACTERS: 'The phone number contains characters that are not allowed.',
  PHONE_INVALID_LENGTH: 'The phone number has the wrong number of digits.',
  PHONE_NOT_INDIAN: 'Only Indian mobile numbers are accepted.',
  PHONE_NOT_MOBILE: 'The number is not a mobile number.',
  PHONE_TOO_LONG: 'The phone number is too long.',
  ALTERNATE_SAME_AS_PRIMARY: 'The alternate phone is the same as the main phone.',
  BUDGET_MALFORMED: 'The budget could not be understood.',
  BUDGET_NOT_POSITIVE: 'The budget must be more than zero.',
  BUDGET_RANGE_NOT_SUPPORTED: 'Put the minimum and maximum budget in separate columns.',
  BUDGET_TOO_LARGE: 'The budget is too large.',
  BUDGET_TOO_PRECISE: 'The budget has too many decimal places.',
  BUDGET_UNKNOWN_UNIT: 'The budget unit is not recognised (use L, Lakh, Cr or Crore).',
  BUDGET_MIN_ABOVE_MAX: 'The minimum budget is above the maximum.',
  BHK_MIN_ABOVE_MAX: 'The minimum BHK is above the maximum.',
  LOCALITIES_LIMIT: 'Too many preferred localities.',
  DUPLICATE_IN_FILE: 'Same phone as an earlier row in this file; only the first row is used.',
  EXISTING_LEAD: 'An open lead already has this phone.',
  IMPORT_FAILED: 'The row could not be imported.',
};

export function rowProblemMessage(code: string): string {
  return ROW_MESSAGES[code] ?? 'The value is not valid.';
}
