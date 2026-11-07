import { importIssuesCsv } from '@/modules/imports';
import { requireContext } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { privateResponse, privateRoute } from '@/platform/http/private-response';

/**
 * All row problems of one import as CSV (FR-047): row, column heading, field, outcome, message.
 * No cell values; cells starting with = + - @ are neutralised for spreadsheet apps.
 * Every response, including refusals, is private and never cached.
 */
export const GET = privateRoute(
  'import-issues-csv',
  async (_: Request, { params }: RouteContext<'/app/leads/import/[id]/issues.csv'>) => {
    const { id } = await params;
    try {
      const csv = await importIssuesCsv(await requireContext(), id);
      return privateResponse(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="import-${id.slice(0, 8)}-problems.csv"`,
        },
      });
    } catch (e) {
      if (e instanceof DomainError) {
        // Unauthenticated → 401; no permission or another org's import → 404 (no existence leak).
        const status = e.code === 'UNAUTHENTICATED' ? 401 : 404;
        return privateResponse(status === 401 ? 'Sign in first' : 'Not found', { status });
      }
      throw e;
    }
  },
);
