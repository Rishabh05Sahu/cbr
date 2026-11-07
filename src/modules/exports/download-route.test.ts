// Route-level regression for the export download route (M5 §I.4 F1): an unexpected exception
// inside the route becomes a generic 500 that no browser may cache, logs the failure, and leaks
// nothing. The failure is injected through the route's own dependency (the export service), not
// through any endpoint. Authorisation behaviour around it is unchanged.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forbidden } from '@/platform/errors';

const h = vi.hoisted(() => ({
  download: vi.fn(),
  requireContext: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('@/platform/observability/logger', () => ({ logger: { error: h.logError } }));
vi.mock('@/platform/auth/session', () => ({ requireContext: h.requireContext }));
vi.mock('@/platform/storage', () => ({ exportStorage: () => ({ kind: 'test-storage' }) }));
vi.mock('@/modules/exports', () => ({
  downloadLeadExport: h.download,
  ExportDeliveryFailed: class ExportDeliveryFailed extends Error {},
}));

const { GET } = await import('@/app/(app)/app/leads/exports/[id]/download/route');

const ID = '0199a000-0000-7000-8000-0000000000aa';
const OWNER = { orgId: 'org-a', userId: 'owner-a' };
const get = () =>
  GET(new Request(`http://localhost/app/leads/exports/${ID}/download`), {
    params: Promise.resolve({ id: ID }),
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  h.requireContext.mockResolvedValue(OWNER);
});

describe('export download route: unexpected exception', () => {
  it('returns a generic, uncacheable 500 and logs the failure without leaking it', async () => {
    const boom = new TypeError('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
    h.download.mockRejectedValue(boom);

    const res = await get();

    // The route really ran with the signed-in context and the export id.
    expect(h.download).toHaveBeenCalledOnce();
    expect(h.download).toHaveBeenCalledWith(OWNER, ID, { storage: { kind: 'test-storage' } });
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBeNull();
    const body = await res.text();
    expect(body).toBe('Something went wrong. Try again later.');
    expect(body).not.toMatch(/ECONNREFUSED|hunter2|TypeError|at /);
    expect(h.logError).toHaveBeenCalledOnce();
    expect(h.logError).toHaveBeenCalledWith(
      { route: 'lead-export-download', err: boom },
      'private route failed',
    );
  });

  it('a non-Error throw is handled the same way', async () => {
    h.download.mockRejectedValue('string failure');
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toBe('Something went wrong. Try again later.');
  });

  it('authorisation is unchanged: a refused role still gets the generic, private 404', async () => {
    h.download.mockRejectedValue(forbidden('Only the Owner can export'));
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.logError).not.toHaveBeenCalled();
  });
});
