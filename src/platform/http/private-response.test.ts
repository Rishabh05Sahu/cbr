// M5 §I.4 F1: every response of a per-user file route is private and never cached, whatever path
// produced it — success, refusal, delivery failure or an unexpected error.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ruleViolation, unauthenticated, notFound, forbidden } from '@/platform/errors';

const h = vi.hoisted(() => ({
  download: vi.fn(),
  issues: vi.fn(),
  requireContext: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/platform/observability/logger', () => ({ logger: { error: h.logError } }));
vi.mock('@/platform/auth/session', () => ({ requireContext: h.requireContext }));
vi.mock('@/platform/storage', () => ({ exportStorage: () => ({}) }));
vi.mock('@/modules/exports', () => {
  class ExportDeliveryFailed extends Error {}
  return { downloadLeadExport: h.download, ExportDeliveryFailed };
});
vi.mock('@/modules/imports', () => ({ importIssuesCsv: h.issues }));

const { privateResponse, privateRoute, PRIVATE_NO_STORE } = await import('./private-response');
const exportsModule = await import('@/modules/exports');
const { GET: downloadGET } = await import('@/app/(app)/app/leads/exports/[id]/download/route');
const { GET: issuesGET } = await import('@/app/(app)/app/leads/import/[id]/issues.csv/route');

const ID = '0199a000-0000-7000-8000-000000000001';
type Case = [string, () => Promise<unknown>, number];
const call = (get: (req: Request, ctx: never) => Promise<Response>) =>
  get(new Request('http://localhost/x'), { params: Promise.resolve({ id: ID }) } as never);

function expectPrivate(res: Response) {
  expect(res.headers.get('cache-control')).toBe(PRIVATE_NO_STORE);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireContext.mockResolvedValue({ orgId: 'org', userId: 'user' });
});

describe('privateResponse / privateRoute', () => {
  it('a caller cannot override the cache header', () => {
    const res = privateResponse('x', { headers: { 'cache-control': 'public, max-age=600' } });
    expectPrivate(res);
  });

  it('forces the headers on whatever the handler returns', async () => {
    const res = await privateRoute(
      't',
      async () => new Response('x', { status: 418, headers: { 'cache-control': 'max-age=60' } }),
    )();
    expect(res.status).toBe(418);
    expectPrivate(res);
  });

  it('an unexpected error becomes a generic, private 500 and is logged', async () => {
    const res = await privateRoute('t', async () => {
      throw new Error('db exploded: password=secret');
    })();
    expect(res.status).toBe(500);
    expectPrivate(res);
    expect(await res.text()).not.toContain('secret');
    expect(h.logError).toHaveBeenCalledOnce();
  });
});

describe('export download route: every path is private', () => {
  it.each<Case>([
    ['success', async () => ({ fileName: 'lead-export-x.csv', body: new Uint8Array([1, 2]) }), 200],
    ['unauthenticated', async () => Promise.reject(unauthenticated()), 401],
    ['wrong role', async () => Promise.reject(forbidden('no')), 404],
    ['other org / missing', async () => Promise.reject(notFound('Export not found')), 404],
    ['used or expired', async () => Promise.reject(ruleViolation('expired or used')), 410],
    [
      'storage failure',
      async () => Promise.reject(new exportsModule.ExportDeliveryFailed('unreadable')),
      503,
    ],
    ['unexpected error', async () => Promise.reject(new Error('boom')), 500],
  ])('%s → %i', async (_, impl, status) => {
    h.download.mockImplementation(impl);
    const res = await call(downloadGET);
    expect(res.status).toBe(status);
    expectPrivate(res);
    if (status === 200) {
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toContain('lead-export-x.csv');
    }
  });

  it('a session that cannot be resolved is private too', async () => {
    h.requireContext.mockRejectedValue(unauthenticated());
    const res = await call(downloadGET);
    expect(res.status).toBe(401);
    expectPrivate(res);
    expect(h.download).not.toHaveBeenCalled();
  });
});

describe('import problems CSV route: every path is private', () => {
  it.each<Case>([
    ['success', async () => 'row,column\n', 200],
    ['unauthenticated', async () => Promise.reject(unauthenticated()), 401],
    ['other org / no permission', async () => Promise.reject(notFound('no')), 404],
    ['unexpected error', async () => Promise.reject(new Error('boom')), 500],
  ])('%s → %i', async (_, impl, status) => {
    h.issues.mockImplementation(impl);
    const res = await call(issuesGET);
    expect(res.status).toBe(status);
    expectPrivate(res);
  });
});
