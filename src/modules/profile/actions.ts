'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requestHeaders, requireContext, requireUser } from '@/platform/auth/session';
import { resetOwnAuthenticator } from '@/platform/auth/two-factor';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import { updateMyProfile } from './index';

type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};

export async function updateProfileAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    updateMyProfile(await requireContext(), { name: str(fd, 'name'), phone: str(fd, 'phone') }),
  );
  if (r.ok) revalidatePath('/app', 'layout');
  return r;
}

/** Lost/replaced phone: password + current code or a recovery code (item D). */
export async function replaceAuthenticatorAction(_: R | null, fd: FormData) {
  return runAction(async () => {
    await requireUser();
    await resetOwnAuthenticator(await requestHeaders(), {
      password: str(fd, 'password'),
      code: str(fd, 'code'),
    });
  });
}
