'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { serverEnv } from '@/env';
import { currentResolution, requestHeaders } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as platform from './index';

type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};
const actor = async () => (await currentResolution()).user;

export async function createOrganizationAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    platform.createOrganization(
      await actor(),
      { name: str(fd, 'name'), ownerName: str(fd, 'ownerName'), ownerEmail: str(fd, 'ownerEmail') },
      serverEnv().BETTER_AUTH_URL,
    ),
  );
  if (r.ok) revalidatePath('/platform');
  return r;
}

export async function setOrganizationStatusAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    platform.setOrganizationStatus(await actor(), str(fd, 'orgId'), str(fd, 'status')),
  );
  if (r.ok) revalidatePath('/platform');
  return r;
}

export async function requestSupportGrantAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    platform.requestSupportGrant(await actor(), {
      orgId: str(fd, 'orgId'),
      reason: str(fd, 'reason'),
      hours: str(fd, 'hours'),
    }),
  );
  if (r.ok) revalidatePath('/platform');
  return r;
}

export async function openOrgForSupportAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    platform.openOrgForSupport(await actor(), await requestHeaders(), str(fd, 'orgId')),
  );
  if (!r.ok) return r;
  redirect('/app');
}

export async function resetUserTwoFactorAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    platform.resetUserTwoFactor(
      await actor(),
      {
        email: str(fd, 'email'),
        reason: str(fd, 'reason'),
        verificationReference: str(fd, 'verificationReference'),
      },
      serverEnv().BETTER_AUTH_URL,
    ),
  );
  if (r.ok) revalidatePath('/platform');
  return r;
}
