import { ActionFormButton } from '@/components/action-form-button';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { listGrants } from '@/modules/support-access';
import { approveGrantAction, revokeGrantAction } from '@/modules/support-access/actions';
import { pageContext, pageRequire } from '@/platform/auth/session';

const fmt = (d: Date) =>
  d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

export default async function SupportAccessPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'support_access.approve');
  const grants = await listGrants(ctx);
  const now = new Date();
  return (
    <>
      <PageHeader
        title="Support access"
        description="CBR platform staff cannot see your data unless you approve a time-limited, read-only request. Every use is recorded in your audit log."
      />
      <Card>
        {grants.length === 0 ? (
          <EmptyState>No support access requests.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {grants.map((g) => {
              const live = !g.revokedAt && g.expiresAt > now;
              return (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <p className="font-medium">{g.reason}</p>
                    <p className="text-slate-600">
                      {g.accessLevel.toLowerCase()} · until {fmt(g.expiresAt)}{' '}
                      {g.revokedAt ? (
                        <Badge>revoked</Badge>
                      ) : !live ? (
                        <Badge>expired</Badge>
                      ) : g.approved ? (
                        <Badge tone="warn">active</Badge>
                      ) : (
                        <Badge>awaiting approval</Badge>
                      )}
                    </p>
                  </div>
                  {live && (
                    <span className="flex gap-2">
                      {!g.approved && (
                        <ActionFormButton
                          action={approveGrantAction}
                          fields={{ grantId: g.id }}
                          label="Approve"
                          variant="primary"
                          confirm="Allow read-only support access until the expiry time?"
                        />
                      )}
                      <ActionFormButton
                        action={revokeGrantAction}
                        fields={{ grantId: g.id }}
                        label={g.approved ? 'Revoke' : 'Decline'}
                        variant="danger"
                      />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
