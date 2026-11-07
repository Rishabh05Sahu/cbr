// Server Action adapter: one place that maps errors to ActionResult and logs unexpected ones.
// Actions never throw to the client (repository-structure §2).
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { DomainError, type ActionResult } from './errors';
import { logger } from './observability/logger';
import { RateLimited } from './rate-limit';
import { RolePolicyError } from './auth/roles';

export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof DomainError) {
      return {
        ok: false,
        error: {
          code: e.code,
          message: e.message,
          ...(e.fieldErrors ? { fieldErrors: e.fieldErrors } : {}),
        },
      };
    }
    if (e instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of e.issues) {
        const key = issue.path.join('.') || '_';
        (fieldErrors[key] ??= []).push(issue.message);
      }
      return {
        ok: false,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Please check the highlighted fields',
          fieldErrors,
        },
      };
    }
    if (e instanceof RateLimited) {
      return { ok: false, error: { code: 'RATE_LIMITED', message: e.message } };
    }
    if (e instanceof RolePolicyError) {
      return {
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: 'Choose exactly one valid role' },
      };
    }
    // Next.js control-flow (redirect/notFound) must propagate.
    if (
      e instanceof Error &&
      'digest' in e &&
      typeof (e as { digest?: unknown }).digest === 'string'
    )
      throw e;
    const requestId = randomUUID();
    logger.error(
      {
        err: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
        requestId,
      },
      'unexpected action error',
    );
    return {
      ok: false,
      error: { code: 'INTERNAL', message: `Something went wrong (ref ${requestId.slice(0, 8)})` },
    };
  }
}
