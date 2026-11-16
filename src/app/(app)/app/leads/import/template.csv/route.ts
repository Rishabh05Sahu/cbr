import { importTemplateCsv } from '@/modules/imports';
import { requireContext } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { privateResponse, privateRoute } from '@/platform/http/private-response';

/**
 * The lead import template: a header row whose headings map themselves, including this
 * organisation's active custom fields. Owners and Admins (lead.import). Private, never cached.
 */
export const GET = privateRoute('import-template-csv', async () => {
  try {
    const csv = await importTemplateCsv(await requireContext());
    return privateResponse(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="lead-import-template.csv"',
      },
    });
  } catch (e) {
    if (e instanceof DomainError) {
      const status = e.code === 'UNAUTHENTICATED' ? 401 : 404;
      return privateResponse(status === 401 ? 'Sign in first' : 'Not found', { status });
    }
    throw e;
  }
});
