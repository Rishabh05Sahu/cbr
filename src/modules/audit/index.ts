// Audit module: append-only org audit log (FR audit requirements, database-design §4).
// Public API: writeAudit (inside the caller's transaction) and listAudit.
import { z } from 'zod';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';

export interface AuditEntry {
  action: string; // entity.verb_past, e.g. 'membership.suspended'
  entityType: string;
  entityId?: string | null;
  /** Display-safe details only. Never tokens, passwords, URLs or message bodies. */
  metadata?: Record<string, string | number | boolean | null>;
  actorUserId: string | null;
  actorKind?: 'USER' | 'SYSTEM' | 'PLATFORM';
}

const FORBIDDEN_METADATA_KEYS = /pass|token|secret|url|cookie|otp|code$/i;

export function sanitizeMetadata(
  metadata: AuditEntry['metadata'],
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata).filter(([k]) => !FORBIDDEN_METADATA_KEYS.test(k)),
  );
}

export async function writeAudit(tx: Tx, orgId: string, entry: AuditEntry): Promise<void> {
  const metadata = sanitizeMetadata(entry.metadata);
  await tx.auditLog.create({
    data: {
      orgId,
      actorUserId: entry.actorUserId,
      actorKind: entry.actorKind ?? 'USER',
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      ...(metadata ? { metadata } : {}),
    },
  });
}

export interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorKind: string;
  metadata: unknown;
  occurredAt: Date;
}

const cursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() });

export function encodeCursor(row: { occurredAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.occurredAt.toISOString(), id: row.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

/** Keyset-paginated, newest first (database-design §8). */
export async function listAudit(
  ctx: RequestContext,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ rows: AuditRow[]; nextCursor: string | null }> {
  authorize(ctx, 'audit.read');
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const c = decodeCursor(opts.cursor);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.auditLog.findMany({
      where: c
        ? {
            OR: [
              { occurredAt: { lt: new Date(c.t) } },
              { occurredAt: new Date(c.t), id: { lt: c.id } },
            ],
          }
        : {},
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        actorUserId: true,
        actorKind: true,
        metadata: true,
        occurredAt: true,
      },
    });
    const page = rows.slice(0, limit);
    const actorIds = [...new Set(page.map((r) => r.actorUserId).filter((x): x is string => !!x))];
    // RLS: only users who are members of this org (or self) are visible.
    const users = actorIds.length
      ? await tx.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      rows: page.map((r) => ({
        ...r,
        actorName: r.actorUserId ? (names.get(r.actorUserId) ?? null) : null,
      })),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
    };
  });
}
