import { ActionForm } from '@/components/action-form';
import { Badge, Card, EmptyState, Field, Input, PageHeader } from '@/components/ui';
import { listLeadTags, MAX_TAGS_PER_ORG } from '@/modules/leads';
import { createLeadTagAction } from '@/modules/leads/actions';
import { pageContext, pageRequire } from '@/platform/auth/session';

/**
 * Lead tags (FR-063 "add tag"; OD-05): Owner/Admin. Labels that can be added to selected leads on
 * the lead list. The server normalizes names and refuses duplicates (case and spacing ignored).
 */
export default async function LeadTagsPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'org.settings.manage');
  const tags = await listLeadTags(ctx);

  return (
    <>
      <PageHeader
        title="Lead tags"
        description={`Labels for grouping leads, added to selected leads from the lead list. ${tags.length} of ${MAX_TAGS_PER_ORG}.`}
      />
      <div className="space-y-4">
        <Card
          title="Add a tag"
          description="Case and extra spaces are ignored when comparing names."
        >
          <ActionForm
            action={createLeadTagAction}
            submitLabel="Add tag"
            successMessage="Tag added."
            className="grid gap-4 sm:grid-cols-2"
          >
            <Field label="Name" htmlFor="tag-new-name" hint="For example Site visit done, NRI, Hot">
              <Input id="tag-new-name" name="name" required maxLength={50} />
            </Field>
          </ActionForm>
        </Card>
        <Card title="Tags">
          {tags.length === 0 ? (
            <EmptyState>No tags yet.</EmptyState>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((t) => (
                <Badge key={t.id}>#{t.name}</Badge>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
