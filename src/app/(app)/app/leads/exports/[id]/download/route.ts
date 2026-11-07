import { downloadLeadExport, ExportDeliveryFailed } from '@/modules/exports';
import { requireContext } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { privateResponse, privateRoute } from '@/platform/http/private-response';
import { exportStorage } from '@/platform/storage';

/**
 * Single-use lead export download (FR-066, D3). The download is claimed before any byte is read,
 * then streamed by the server from private storage; no storage URL ever reaches the browser.
 * Every response, including refusals and failures, is private and never cached (§I.4 F1).
 */
export const GET = privateRoute(
  'lead-export-download',
  async (_: Request, { params }: RouteContext<'/app/leads/exports/[id]/download'>) => {
    const { id } = await params;
    try {
      const file = await downloadLeadExport(await requireContext(), id, {
        storage: exportStorage(),
      });
      return privateResponse(Buffer.from(file.body), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${file.fileName}"`,
        },
      });
    } catch (e) {
      if (e instanceof DomainError) {
        // Unauthenticated → 401; not the requester / not an Owner / another org → 404 (no
        // existence leak); expired or already used → 410.
        if (e.code === 'UNAUTHENTICATED') return privateResponse('Sign in first', { status: 401 });
        if (e.code === 'RULE_VIOLATION') return privateResponse(e.message, { status: 410 });
        return privateResponse('Not found', { status: 404 });
      }
      if (e instanceof ExportDeliveryFailed)
        return privateResponse('The export could not be delivered. Request a new export.', {
          status: 503,
        });
      throw e;
    }
  },
);
