import { PageHeader } from '@/components/ui';
import {
  CONTACT_METHODS,
  INTENTS,
  listCustomFields,
  listLeadSources,
  PROPERTY_TYPES,
  PURPOSES,
  TIMELINES,
  TRANSACTION_TYPES,
} from '@/modules/leads';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { LABELS } from '../labels';
import { CreateLeadForm } from './create-form';

export default async function NewLeadPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'lead.create');
  const [sources, customFields] = await Promise.all([listLeadSources(ctx), listCustomFields(ctx)]);
  const opts = (codes: readonly string[]) =>
    codes.map((c) => ({ value: c, label: LABELS[c] ?? c }));
  return (
    <>
      <PageHeader
        title="New lead"
        description="The phone number is checked for an existing open lead before anything is saved. New leads are assigned to you."
      />
      <CreateLeadForm
        sources={sources.map((s) => ({ value: s.id, label: s.name }))}
        customFields={customFields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          required: f.required,
          ...(f.options ? { options: f.options } : {}),
        }))}
        options={{
          transactionType: opts(TRANSACTION_TYPES),
          propertyType: opts(PROPERTY_TYPES),
          preferredContactMethod: opts(CONTACT_METHODS),
          purpose: opts(PURPOSES),
          timeline: opts(TIMELINES),
          intent: opts(INTENTS),
        }}
      />
    </>
  );
}
