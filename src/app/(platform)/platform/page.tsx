import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { ActionFormButton } from '@/components/action-form-button';
import { SignOutButton } from '@/components/sign-out-button';
import { Badge, Card, Field, Input, PageHeader } from '@/components/ui';
import * as platform from '@/modules/platform-admin';
import {
  createOrganizationAction,
  openOrgForSupportAction,
  requestSupportGrantAction,
  resetUserTwoFactorAction,
  setOrganizationStatusAction,
} from '@/modules/platform-admin/actions';
import { currentResolution, TWO_FACTOR_SETUP_PATH } from '@/platform/auth/session';

export const dynamic = 'force-dynamic';

const fmt = (d: Date) =>
  d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

export default async function PlatformPage() {
  const { user } = await currentResolution();
  if (!user) redirect('/login?next=/platform');
  if (user.platformRole !== 'PLATFORM_ADMIN') notFound();
  if (!user.twoFactorEnabled) redirect(TWO_FACTOR_SETUP_PATH);
  const [orgs, audit] = await Promise.all([
    platform.listOrganizations(user),
    platform.listPlatformAudit(user),
  ]);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className="font-semibold text-blue-900">CBR Platform console</span>
          <span className="flex items-center gap-2 text-sm">
            <Link className="underline" href="/app/select-org">
              App
            </Link>
            <SignOutButton />
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <PageHeader
          title="Organisations"
          description="Platform staff see organisation metadata only. Customer data needs an Owner-approved support grant."
        />
        <Card
          title="New organisation"
          description="Creates the organisation and its first Owner. A new Owner receives a set-password email."
        >
          <ActionForm
            action={createOrganizationAction}
            submitLabel="Create"
            successMessage="Organisation created."
            className="grid gap-4 sm:grid-cols-4 sm:items-end"
          >
            <Field label="Organisation name" htmlFor="org-name">
              <Input id="org-name" name="name" required minLength={2} maxLength={120} />
            </Field>
            <Field label="Owner name" htmlFor="owner-name">
              <Input id="owner-name" name="ownerName" required minLength={2} maxLength={100} />
            </Field>
            <Field label="Owner email" htmlFor="owner-email">
              <Input id="owner-email" name="ownerEmail" type="email" required maxLength={254} />
            </Field>
          </ActionForm>
        </Card>
        <Card title={`All organisations (${orgs.length})`}>
          <ul className="divide-y divide-slate-100 text-sm">
            {orgs.map((o) => (
              <li key={o.orgId} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium">{o.name}</span> · {o.activeMembers} active members
                    · created {fmt(o.createdAt)}{' '}
                    <Badge tone={o.status === 'ACTIVE' ? 'good' : 'warn'}>
                      {o.status.toLowerCase()}
                    </Badge>
                  </span>
                  <span className="flex gap-2">
                    <ActionFormButton
                      action={openOrgForSupportAction}
                      fields={{ orgId: o.orgId }}
                      label="Open (needs grant)"
                      variant="ghost"
                    />
                    <ActionFormButton
                      action={setOrganizationStatusAction}
                      fields={{
                        orgId: o.orgId,
                        status: o.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
                      }}
                      label={o.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                      variant={o.status === 'ACTIVE' ? 'danger' : 'secondary'}
                      confirm={
                        o.status === 'ACTIVE'
                          ? `Suspend ${o.name}? All its users lose access.`
                          : `Reactivate ${o.name}?`
                      }
                    />
                  </span>
                </div>
                <details>
                  <summary className="cursor-pointer text-xs text-slate-600">
                    Request support access
                  </summary>
                  <ActionForm
                    action={requestSupportGrantAction}
                    submitLabel="Request"
                    successMessage="Requested. The Owner must approve it."
                    className="mt-2 grid gap-2 sm:grid-cols-3 sm:items-end"
                  >
                    <input type="hidden" name="orgId" value={o.orgId} />
                    <Field label="Reason" htmlFor={`reason-${o.orgId}`}>
                      <Input
                        id={`reason-${o.orgId}`}
                        name="reason"
                        required
                        minLength={10}
                        maxLength={500}
                      />
                    </Field>
                    <Field label="Hours (max 72)" htmlFor={`hours-${o.orgId}`}>
                      <Input
                        id={`hours-${o.orgId}`}
                        name="hours"
                        type="number"
                        min={1}
                        max={72}
                        defaultValue={4}
                        required
                      />
                    </Field>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        </Card>
        <Card
          title="Reset two-step verification"
          description="Only for a user who has lost both their authenticator and their recovery codes, after the identity checks in the two-factor recovery runbook. All their sessions end, their password stops working, and they must reset it by email and set up a new authenticator."
        >
          <ActionForm
            action={resetUserTwoFactorAction}
            successMessage="Reset done. The user has been emailed a password-reset link."
            submitLabel="Reset two-step verification"
          >
            <Field label="User email" htmlFor="tf-email">
              <Input id="tf-email" name="email" type="email" required maxLength={254} />
            </Field>
            <Field label="Reason" htmlFor="tf-reason">
              <Input id="tf-reason" name="reason" required minLength={10} maxLength={500} />
            </Field>
            <Field
              label="Identity verification reference"
              htmlFor="tf-ref"
              hint="Support ticket id recording the checks performed (runbook §2)."
            >
              <Input
                id="tf-ref"
                name="verificationReference"
                required
                minLength={3}
                maxLength={120}
              />
            </Field>
          </ActionForm>
        </Card>
        <Card title="Platform audit (latest 100)">
          <ul className="divide-y divide-slate-100 font-mono text-xs">
            {audit.map((a) => (
              <li key={a.id} className="py-1">
                {fmt(a.occurredAt)} · {a.action} · {a.entityType} {a.entityId ?? ''}
              </li>
            ))}
          </ul>
        </Card>
      </main>
    </div>
  );
}
