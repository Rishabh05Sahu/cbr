import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import {
  DisableTwoFactor,
  RegenerateRecoveryCodes,
  ReplaceAuthenticator,
  SignOutEverywhere,
} from '@/components/two-factor';
import { Card, Field, Input, PageHeader } from '@/components/ui';
import { getMyProfile } from '@/modules/profile';
import { replaceAuthenticatorAction, updateProfileAction } from '@/modules/profile/actions';
import { pageContext, TWO_FACTOR_SETUP_PATH } from '@/platform/auth/session';
import { twoFactorStatus } from '@/platform/auth/two-factor';

export default async function ProfilePage() {
  const { user } = await pageContext();
  const [profile, tf] = await Promise.all([
    getMyProfile(user.id),
    twoFactorStatus(user.id, user.platformRole),
  ]);
  return (
    <>
      <PageHeader title="My profile" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Details">
          <ActionForm
            action={updateProfileAction}
            successMessage="Profile saved."
            submitLabel="Save"
          >
            <Field label="Full name" htmlFor="name">
              <Input
                id="name"
                name="name"
                defaultValue={profile.name}
                required
                minLength={2}
                maxLength={100}
              />
            </Field>
            <Field
              label="Email"
              htmlFor="email"
              hint="Contact your administrator to change your email address."
            >
              <Input id="email" value={profile.email} readOnly disabled />
            </Field>
            <Field
              label="Mobile number"
              htmlFor="phone"
              hint="10-digit Indian mobile or +country code."
            >
              <Input
                id="phone"
                name="phone"
                inputMode="tel"
                defaultValue={profile.phoneE164 ?? ''}
                maxLength={20}
              />
            </Field>
          </ActionForm>
        </Card>
        <Card title="Security">
          <div className="space-y-6">
            {tf.enabled ? (
              <>
                <p className="text-sm text-slate-700">
                  Two-step verification is <strong>on</strong>
                  {tf.mandatory ? ' (required for your role)' : ''}. Recovery codes left:{' '}
                  <strong>{tf.recoveryCodesLeft ?? 0}</strong>.
                </p>
                <RegenerateRecoveryCodes />
                <ReplaceAuthenticator
                  action={replaceAuthenticatorAction}
                  nextHref={TWO_FACTOR_SETUP_PATH}
                />
                {!tf.mandatory && <DisableTwoFactor />}
              </>
            ) : (
              <p className="text-sm text-slate-700">
                Two-step verification is <strong>off</strong>.{' '}
                <Link className="text-blue-800 underline" href={TWO_FACTOR_SETUP_PATH}>
                  Set it up
                </Link>
              </p>
            )}
            <SignOutEverywhere />
          </div>
        </Card>
      </div>
    </>
  );
}
