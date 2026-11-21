// POST /api/v1/leads/:id/reveal-phone — FR-060: one capped, audited reveal (ADR-0013).
import { revealLeadPhone } from '@/modules/leads';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('lead-reveal-phone', ({ ctx, params }) =>
  revealLeadPhone(ctx, params.id),
);
