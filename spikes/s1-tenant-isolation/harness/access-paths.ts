// Stand-ins for the real entry points. The S1 setup allows harness functions; the real
// Next.js paths are re-tested once modules exist.
import { z } from 'zod';
import type { TenantRunner } from '@/platform/db/with-tenant';
import type { Prisma } from '../db/clients';
import { getSession } from './session';
import { listLeads, type LeadListItem } from './lead-repository';

type Runner = TenantRunner<Prisma.TransactionClient>;

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: string } };

// Server Action shape. `orgId` is accepted only to prove a forged value is ignored.
const listLeadsInput = z.object({
  orgId: z.string().optional(),
  take: z.number().int().min(1).max(200).optional(),
});

export function makeListLeadsAction(runner: Runner) {
  return async function listLeadsAction(
    sessionToken: string | undefined,
    rawInput: unknown,
  ): Promise<ActionResult<LeadListItem[]>> {
    const session = getSession(sessionToken);
    if (!session) return { ok: false, error: { code: 'UNAUTHENTICATED' } };
    const input = listLeadsInput.parse(rawInput);
    const data = await runner.withTenant(
      { orgId: session.activeOrgId, userId: session.userId },
      (tx) => listLeads(tx, session.userId, input.take === undefined ? {} : { take: input.take }),
    );
    return { ok: true, data };
  };
}

/** Route Handler shape: GET /api/leads?orgId=... (the query org is ignored). */
export function makeLeadsRouteHandler(runner: Runner) {
  return async function GET(request: Request): Promise<Response> {
    const token = request.headers.get('cookie')?.match(/session=([^;]+)/)?.[1];
    const session = getSession(token);
    if (!session) return Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    const data = await runner.withTenant(
      { orgId: session.activeOrgId, userId: session.userId },
      (tx) => listLeads(tx, session.userId),
    );
    return Response.json({ data });
  };
}

export interface ResolvedConnection {
  org_id: string;
  connection_id: string;
}

/**
 * Webhook Route Handler shape: POST /api/webhooks/[provider]/[token].
 * The org is resolved only via the definer function, from the hashed path token.
 */
export function makeWebhookHandler(
  runner: Runner,
  resolve: (tokenHash: string) => Promise<ResolvedConnection | null>,
  hash: (token: string) => string,
) {
  return async function POST(request: Request, token: string): Promise<Response> {
    const connection = await resolve(hash(token));
    if (!connection) return new Response(null, { status: 404 });
    const body = z.object({ leadId: z.uuid(), outcome: z.string() }).parse(await request.json());
    // Payload ids are untrusted: an id from another org is simply not found.
    const created = await runner.withTenant(
      { orgId: connection.org_id, userId: null },
      async (tx) => {
        const lead = await tx.lead.findUnique({
          where: { id: body.leadId },
          select: { id: true, ownerUserId: true },
        });
        if (!lead?.ownerUserId) return null;
        return tx.interaction.create({
          data: {
            orgId: connection.org_id,
            leadId: lead.id,
            userId: lead.ownerUserId,
            outcome: body.outcome,
          },
          select: { id: true },
        });
      },
    );
    return created
      ? Response.json({ id: created.id }, { status: 201 })
      : new Response(null, { status: 404 });
  };
}

// Worker handler shape: the payload carries orgId; the referenced entity must belong to it.
const jobPayload = z.object({ orgId: z.uuid(), leadId: z.uuid(), title: z.string() });

export class JobEntityNotFound extends Error {
  override readonly name = 'JobEntityNotFound';
}

export function makeCreateFollowUpJob(runner: Runner) {
  return async function handle(rawPayload: unknown): Promise<{ taskId: string }> {
    const payload = jobPayload.parse(rawPayload);
    return runner.withTenant({ orgId: payload.orgId, userId: null }, async (tx) => {
      const lead = await tx.lead.findUnique({
        where: { id: payload.leadId },
        select: { id: true, ownerUserId: true },
      });
      if (!lead?.ownerUserId)
        throw new JobEntityNotFound(`lead ${payload.leadId} not found in org`);
      const task = await tx.task.create({
        data: {
          orgId: payload.orgId,
          leadId: lead.id,
          assigneeUserId: lead.ownerUserId,
          title: payload.title,
          dueAt: new Date(Date.now() + 86_400_000),
        },
        select: { id: true },
      });
      return { taskId: task.id };
    });
  };
}
