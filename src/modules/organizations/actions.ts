'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { setActiveOrganization } from '@/platform/auth/org-admin';
import { requestHeaders, requireContext, requireUser } from '@/platform/auth/session';
import { listMyMemberships } from '@/platform/auth/context';
import { runAction } from '@/platform/actions';
import { forbidden, type ActionResult } from '@/platform/errors';
import { updateOrgSettings, updatePhoneMasking } from './index';

type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};

export async function updateOrgSettingsAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    updateOrgSettings(await requireContext(), {
      name: str(fd, 'name'),
      timeZone: str(fd, 'timeZone'),
      locale: str(fd, 'locale') || 'en-IN',
    }),
  );
  if (r.ok) revalidatePath('/app', 'layout');
  return r;
}

export async function updatePhoneMaskingAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    updatePhoneMasking(await requireContext(), {
      enabled: fd.get('enabled') === 'on',
      dailyCap: str(fd, 'dailyCap'),
    }),
  );
  if (r.ok) revalidatePath('/app', 'layout');
  return r;
}

/** Switch the active organisation; only to orgs where the user has an active membership. */
export async function switchOrganizationAction(_: R | null, fd: FormData) {
  const r = await runAction(async () => {
    const user = await requireUser();
    const orgId = z.uuid().parse(str(fd, 'orgId'));
    const mine = await listMyMemberships(user.id);
    if (!mine.some((m) => m.orgId === orgId))
      throw forbidden('You are not a member of that organisation');
    await setActiveOrganization(await requestHeaders(), orgId);
  });
  if (!r.ok) return r;
  revalidatePath('/app', 'layout');
  redirect('/app');
}
