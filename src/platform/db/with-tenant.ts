import { z } from 'zod';

/**
 * Tenant context gateway (ADR-0004, database-design.md §2.5).
 *
 * The only supported way to run tenant queries: an interactive transaction that first
 * sets `app.org_id` / `app.user_id` with `set_config(..., is_local => true)`. The setting
 * ends with the transaction (commit or rollback), so a pooled connection never carries
 * one tenant's context into the next borrower. RLS policies read the setting and match
 * nothing when it is absent (fail closed).
 *
 * Failure behaviour:
 * - Invalid ids throw `TenantContextError` before any connection is borrowed.
 * - With `readOnly`, any write raises (PostgreSQL `SET TRANSACTION READ ONLY`).
 * - An error thrown by `fn` rolls the transaction back and is re-thrown unchanged.
 * - Queries issued outside this wrapper (on the raw client) run with no context and see
 *   zero tenant rows.
 *
 * The org id must come from the authenticated session or a verified token lookup,
 * never from request input.
 */

export interface TenantContext {
  readonly orgId: string;
  /** `null` for system actors (webhooks, scheduled jobs) acting for the org. */
  readonly userId: string | null;
  /** Database-enforced read-only transaction (e.g. READ support-access grants). */
  readonly readOnly?: boolean;
}

export interface TransactionOptions {
  readonly maxWait?: number;
  readonly timeout?: number;
}

/** Minimal structural view of a Prisma 7 client, so this module does not depend on a generated client. */
export interface RawQueryable {
  $queryRawUnsafe(query: string, ...values: unknown[]): PromiseLike<unknown>;
}

export interface InteractiveTransactionClient<Tx extends RawQueryable> {
  $transaction<R>(fn: (tx: Tx) => Promise<R>, options?: TransactionOptions): Promise<R>;
}

export class TenantContextError extends Error {
  override readonly name = 'TenantContextError';
}

const uuidSchema = z.uuid();

function assertUuid(value: string, field: string): void {
  if (!uuidSchema.safeParse(value).success) {
    throw new TenantContextError(`${field} must be a UUID`);
  }
}

const SET_TENANT_SQL =
  "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)";
const SET_USER_SQL = "SELECT set_config('app.user_id', $1, true)";

export interface TenantRunner<Tx extends RawQueryable> {
  /** Run `fn` inside one transaction scoped to `ctx.orgId`. */
  withTenant<R>(
    ctx: TenantContext,
    fn: (tx: Tx) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R>;
  /**
   * Pre-tenant work for an authenticated user with no org selected yet (e.g. resolving
   * memberships). Sets only `app.user_id`; tenant tables stay invisible.
   */
  withUser<R>(userId: string, fn: (tx: Tx) => Promise<R>, options?: TransactionOptions): Promise<R>;
}

export function createTenantRunner<Tx extends RawQueryable>(
  client: InteractiveTransactionClient<Tx>,
  defaults: TransactionOptions = {},
): TenantRunner<Tx> {
  return {
    async withTenant(ctx, fn, options) {
      assertUuid(ctx.orgId, 'orgId');
      if (ctx.userId !== null) assertUuid(ctx.userId, 'userId');
      return client.$transaction(
        async (tx) => {
          if (ctx.readOnly) await tx.$queryRawUnsafe('SET TRANSACTION READ ONLY');
          await tx.$queryRawUnsafe(SET_TENANT_SQL, ctx.orgId, ctx.userId ?? '');
          return fn(tx);
        },
        { ...defaults, ...options },
      );
    },
    async withUser(userId, fn, options) {
      assertUuid(userId, 'userId');
      return client.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(SET_USER_SQL, userId);
          return fn(tx);
        },
        { ...defaults, ...options },
      );
    },
  };
}
