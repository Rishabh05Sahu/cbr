import { ActionForm } from '@/components/action-form';
import { Card, Field, Input, PageHeader, Select } from '@/components/ui';
import { getOrgSettings, getPhoneMaskingSettings } from '@/modules/organizations';
import { updateOrgSettingsAction, updatePhoneMaskingAction } from '@/modules/organizations/actions';
import { pageContext } from '@/platform/auth/session';
import { can } from '@/platform/authz';

const ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'UTC',
];

export default async function OrganizationPage() {
  const { ctx } = await pageContext();
  const org = await getOrgSettings(ctx);
  const editable = can(ctx, 'org.settings.manage');
  // Masking status and the reveal limit: Owner/Admin only (the same permission as editing).
  const masking = editable ? await getPhoneMaskingSettings(ctx) : null;
  const fields = (
    <fieldset disabled={!editable} className="space-y-4">
      <Field label="Organisation name" htmlFor="name">
        <Input
          id="name"
          name="name"
          defaultValue={org.name}
          required
          minLength={2}
          maxLength={120}
        />
      </Field>
      <Field label="Time zone" htmlFor="timeZone">
        <Select id="timeZone" name="timeZone" defaultValue={org.timeZone}>
          {[...new Set([org.timeZone, ...ZONES])].map((z) => (
            <option key={z}>{z}</option>
          ))}
        </Select>
      </Field>
      <Field label="Locale" htmlFor="locale">
        <Select id="locale" name="locale" defaultValue={org.locale}>
          <option value="en-IN">English (India)</option>
        </Select>
      </Field>
    </fieldset>
  );
  return (
    <>
      <PageHeader
        title="Organisation"
        description="Name, time zone and locale used for working hours and reports."
      />
      <Card>
        {editable ? (
          <ActionForm
            action={updateOrgSettingsAction}
            successMessage="Settings saved."
            submitLabel="Save"
          >
            {fields}
          </ActionForm>
        ) : (
          fields
        )}
      </Card>
      {masking && (
        <div className="mt-6">
          <Card
            title="Phone masking"
            description="When on, lead phone numbers are shown masked. Revealing one is a separate action that is recorded in the audit log and limited per person per day."
          >
            {masking.canManage ? (
              <ActionForm
                action={updatePhoneMaskingAction}
                successMessage="Phone masking saved."
                submitLabel="Save phone masking"
                resetOnSuccess={false}
                fieldLabels={{ dailyCap: 'Reveals per person per day' }}
              >
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="enabled" defaultChecked={masking.enabled} />
                  Mask lead phone numbers
                </label>
                <Field
                  label="Reveals per person per day"
                  htmlFor="dailyCap"
                  hint="Between 1 and 1000. Counted in the organisation's time zone."
                >
                  <Input
                    id="dailyCap"
                    name="dailyCap"
                    type="number"
                    min={1}
                    max={1000}
                    required
                    defaultValue={masking.dailyCap}
                  />
                </Field>
              </ActionForm>
            ) : (
              <p className="text-sm text-slate-700">
                {masking.enabled
                  ? `On. Up to ${masking.dailyCap} reveals per person per day.`
                  : 'Off.'}{' '}
                Only the Owner can change this.
              </p>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
