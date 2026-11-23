// GET /api/v1/assignment-targets — who the caller may assign leads to: people and teams in their
// lead.assign scope (all for Owner/Admin, the teams they lead for a Sales Manager), and whether
// the org-wide queue is a target (FR-070/072/073). Every assign command re-validates the target.
import { assignmentTargets } from '@/modules/leads';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('assignment-targets', ({ ctx }) => assignmentTargets(ctx));
