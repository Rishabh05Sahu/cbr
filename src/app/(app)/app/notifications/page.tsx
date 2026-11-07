import Link from 'next/link';
import { ActionFormButton } from '@/components/action-form-button';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { listNotifications } from '@/modules/notifications';
import { markAllReadAction, markReadAction } from '@/modules/notifications/actions';
import { pageContext } from '@/platform/auth/session';
import { fmtDateTime } from '../leads/labels';

/** FR-118: the caller's own notifications, newest first (RLS limits rows to the recipient). */
export default async function NotificationsPage({ searchParams }: PageProps<'/app/notifications'>) {
  const { ctx } = await pageContext();
  const sp = await searchParams;
  const cursor = typeof sp.cursor === 'string' ? sp.cursor : undefined;
  const { rows, nextCursor } = await listNotifications(ctx, { cursor });
  const anyUnread = rows.some((n) => !n.readAt);
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader title="Notifications" description="Assignments and returning enquiries." />
        {anyUnread && (
          <ActionFormButton action={markAllReadAction} fields={{}} label="Mark all as read" />
        )}
      </div>
      <Card>
        {rows.length === 0 ? (
          <EmptyState>{cursor ? 'No older notifications.' : 'No notifications yet.'}</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {rows.map((n) => (
              <li key={n.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                <div>
                  <p className="font-medium text-slate-900">
                    {!n.readAt && (
                      <>
                        <Badge tone="good">New</Badge>{' '}
                      </>
                    )}
                    {n.link ? (
                      <Link
                        href={n.link as '/app'}
                        className="text-blue-900 underline-offset-2 hover:underline"
                      >
                        {n.title}
                      </Link>
                    ) : (
                      n.title
                    )}
                  </p>
                  <p className="text-slate-700">{n.body}</p>
                  <p className="text-xs text-slate-500">{fmtDateTime(n.createdAt)}</p>
                </div>
                {!n.readAt && (
                  <ActionFormButton
                    action={markReadAction}
                    fields={{ notificationId: n.id }}
                    label="Mark read"
                    variant="ghost"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {(cursor || nextCursor) && (
          <nav aria-label="Pages" className="mt-4 flex justify-between text-sm">
            {cursor ? (
              <Link href="/app/notifications" className="underline">
                ← Newest
              </Link>
            ) : (
              <span />
            )}
            {nextCursor && (
              <Link
                href={`/app/notifications?cursor=${nextCursor}` as '/app/notifications'}
                className="underline"
              >
                Older →
              </Link>
            )}
          </nav>
        )}
      </Card>
    </>
  );
}
