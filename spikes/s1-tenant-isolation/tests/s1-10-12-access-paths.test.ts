// S1-10 Server Action path, S1-11 Route Handler + webhook path, S1-12 worker path.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppClient, createMigratorClient, tenantRunnerFor } from '../db/clients';
import {
  JobEntityNotFound,
  makeCreateFollowUpJob,
  makeLeadsRouteHandler,
  makeListLeadsAction,
  makeWebhookHandler,
  type ResolvedConnection,
} from '../harness/access-paths';
import { createSession } from '../harness/session';
import { seedOrg, type OrgFixture } from './fixtures';

const migrator = createMigratorClient();
const app = createAppClient(5);
const runner = tenantRunnerFor(app);
let A: OrgFixture;
let B: OrgFixture;

beforeAll(async () => {
  A = await seedOrg(migrator, 'Golf');
  B = await seedOrg(migrator, 'Hotel');
  createSession('tok-a-exec1', { userId: A.users.exec1, activeOrgId: A.orgId });
  createSession('tok-a-admin', { userId: A.users.admin, activeOrgId: A.orgId });
  createSession('tok-b-admin', { userId: B.users.admin, activeOrgId: B.orgId });
});
afterAll(async () => {
  await app.close();
  await migrator.close();
});

describe('S1-10 Server Action path', () => {
  const action = makeListLeadsAction(runner);

  it('sees only the session org; a forged orgId in input has no effect', async () => {
    const res = await action('tok-a-admin', { orgId: B.orgId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBe(Object.keys(A.leads).length);
    expect(res.data.every((l) => l.orgId === A.orgId)).toBe(true);
  });

  it('scope still applies: an executive sees only own leads', async () => {
    const res = await action('tok-a-exec1', { orgId: B.orgId });
    expect(res.ok && res.data.map((l) => l.id)).toEqual([A.leads.exec1]);
  });

  it('no session -> UNAUTHENTICATED, no query', async () => {
    expect(await action(undefined, {})).toEqual({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await action('forged-token', { orgId: A.orgId })).toEqual({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    });
  });
});

describe('S1-11 Route Handler path', () => {
  const GET = makeLeadsRouteHandler(runner);

  it('uses the session org, ignoring ?orgId=', async () => {
    const res = await GET(
      new Request(`http://localhost/api/leads?orgId=${B.orgId}`, {
        headers: { cookie: 'session=tok-a-admin' },
      }),
    );
    const body = (await res.json()) as { data: { orgId: string }[] };
    expect(res.status).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((l) => l.orgId === A.orgId)).toBe(true);
  });

  it('unauthenticated -> 401', async () => {
    const res = await GET(new Request(`http://localhost/api/leads?orgId=${A.orgId}`));
    expect(res.status).toBe(401);
  });

  describe('webhook handler resolves org only via resolve_webhook_connection', () => {
    // In the spike the stored "hash" is the token itself; production stores sha256(token).
    const resolve = async (tokenHash: string): Promise<ResolvedConnection | null> => {
      const rows = await app.prisma.$queryRaw<ResolvedConnection[]>`
        SELECT org_id, connection_id FROM app.resolve_webhook_connection(${tokenHash})`;
      return rows[0] ?? null;
    };
    const POST = makeWebhookHandler(runner, resolve, (t) => t);
    const req = (leadId: string) =>
      new Request('http://localhost/api/webhooks/exotel/x', {
        method: 'POST',
        body: JSON.stringify({ leadId, outcome: 'CONNECTED' }),
      });

    it('valid token + own lead -> 201, interaction written to that org', async () => {
      const res = await POST(req(A.leads.exec1!), A.connectionTokenHash);
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      const row = await migrator.prisma.interaction.findUnique({ where: { id } });
      expect(row?.orgId).toBe(A.orgId);
    });

    it("valid token for A + B's lead id in payload -> 404, nothing written", async () => {
      const before = await migrator.prisma.interaction.count();
      const res = await POST(req(B.leads.exec1!), A.connectionTokenHash);
      expect(res.status).toBe(404);
      expect(await migrator.prisma.interaction.count()).toBe(before);
    });

    it('unknown token -> 404', async () => {
      const res = await POST(req(A.leads.exec1!), 'not-a-token');
      expect(res.status).toBe(404);
    });
  });
});

describe('S1-12 worker path', () => {
  const handle = makeCreateFollowUpJob(runner);

  it('job runs under withTenant(payload.orgId) and creates the task in that org', async () => {
    const { taskId } = await handle({ orgId: A.orgId, leadId: A.leads.exec2, title: 'Follow up' });
    const task = await migrator.prisma.task.findUnique({ where: { id: taskId } });
    expect(task?.orgId).toBe(A.orgId);
  });

  it('payload org mismatching the entity org finds 0 rows and fails safely', async () => {
    const before = await migrator.prisma.task.count();
    await expect(
      handle({ orgId: A.orgId, leadId: B.leads.exec2, title: 'x' }),
    ).rejects.toBeInstanceOf(JobEntityNotFound);
    expect(await migrator.prisma.task.count()).toBe(before);
  });

  it('malformed payload is rejected before touching the database', async () => {
    await expect(handle({ orgId: 'nope', leadId: A.leads.exec2, title: 'x' })).rejects.toThrow();
  });
});
