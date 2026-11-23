// GET /api/v1/visits — the Visits tab of the Android app: the same list as the website's Visits
// page (myVisits: visits on leads in the caller's scope and visits assigned to them), open ones by
// time and the 20 most recent closed ones. `canManage` marks those the caller may change here.
import { myVisits } from '@/modules/visits';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('visits', ({ ctx }) => myVisits(ctx));
