'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import { approveGrant, revokeGrant } from './index';

type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};

export async function approveGrantAction(_: R | null, fd: FormData) {
  const r = await runAction(async () => approveGrant(await requireContext(), str(fd, 'grantId')));
  if (r.ok) revalidatePath('/app/settings/support-access');
  return r;
}

export async function revokeGrantAction(_: R | null, fd: FormData) {
  const r = await runAction(async () => revokeGrant(await requireContext(), str(fd, 'grantId')));
  if (r.ok) revalidatePath('/app/settings/support-access');
  return r;
}
