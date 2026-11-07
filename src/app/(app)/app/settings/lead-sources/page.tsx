import { ActionForm } from '@/components/action-form';
import { Badge, Card, EmptyState, Field, Input, PageHeader, Select } from '@/components/ui';
import { LEAD_SOURCE_CHANNELS, listLeadSourcesForSettings } from '@/modules/leads';
import { createLeadSourceAction } from '@/modules/leads/actions';
import { pageContext, pageRequire } from '@/platform/auth/session';

const CHANNEL_LABELS: Record<string, string> = {
  PORTAL: 'Property portal',
  SOCIAL_ADS: 'Social media ads',
  WEBSITE: 'Website',
  REFERRAL: 'Referral',
  WALK_IN: 'Walk-in',
  CHANNEL_PARTNER: 'Channel partner',
  COLD: 'Cold outreach',
  OTHER: 'Other',
};

/**
 * Lead sources: Owner/Admin. Imports match a file's Source column to these names, ignoring
 * case and extra spaces; the lead form lists the active ones. The server normalizes names and
 * refuses duplicates; the form only explains it.
 */
export default async function LeadSourcesPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'org.settings.manage');
  const sources = await listLeadSourcesForSettings(ctx);

  return (
    <>
      <PageHeader
        title="Lead sources"
        description="Where leads come from. An import row whose Source names no active source here is reported as a problem, so add your portals and campaigns before importing."
      />
      <div className="space-y-4">
        <Card
          title="Add a source"
          description="Use the name exactly as it appears in your files; case and extra spaces are ignored."
        >
          <ActionForm
            action={createLeadSourceAction}
            submitLabel="Add source"
            successMessage="Source added."
            className="grid gap-4 sm:grid-cols-2"
          >
            <Field
              label="Name"
              htmlFor="ls-new-name"
              hint="For example 99acres, MagicBricks, Website"
            >
              <Input id="ls-new-name" name="name" required maxLength={100} />
            </Field>
            <Field label="Channel" htmlFor="ls-new-channel">
              <Select id="ls-new-channel" name="channel" required defaultValue="PORTAL">
                {LEAD_SOURCE_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABELS[c] ?? c}
                  </option>
                ))}
              </Select>
            </Field>
          </ActionForm>
        </Card>

        <Card title="Sources">
          {sources.length === 0 ? (
            <EmptyState>No sources yet. Leads without a source use “Unknown”.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {sources.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <p className="text-sm">
                    <span className="font-medium text-slate-900">{s.name}</span> ·{' '}
                    {CHANNEL_LABELS[s.channel] ?? s.channel}
                  </p>
                  {!s.isActive && <Badge tone="warn">Inactive</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
