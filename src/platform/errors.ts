// Typed domain errors, mapped once to UI/HTTP (repository-structure §2).

export class DomainError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'FORBIDDEN'
      | 'CONFLICT'
      | 'VALIDATION_FAILED'
      | 'RULE_VIOLATION'
      | 'UNAUTHENTICATED'
      | 'RATE_LIMITED'
      | 'TWO_FACTOR_REQUIRED',
    message: string,
    readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what = 'Not found') => new DomainError('NOT_FOUND', what);
export const forbidden = (why = 'You do not have permission to do this') =>
  new DomainError('FORBIDDEN', why);
export const conflict = (why: string) => new DomainError('CONFLICT', why);
export const ruleViolation = (why: string) => new DomainError('RULE_VIOLATION', why);
export const unauthenticated = () => new DomainError('UNAUTHENTICATED', 'Please sign in');

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string[]> } };
