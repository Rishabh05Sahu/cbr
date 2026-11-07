'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as notifications from './index';

type R = ActionResult<unknown>;

export async function markReadAction(_: R | null, fd: FormData) {
  const id = fd.get('notificationId');
  const r = await runAction(async () =>
    notifications.markRead(await requireContext(), typeof id === 'string' ? id : ''),
  );
  if (r.ok) revalidatePath('/app', 'layout');
  return r;
}

export async function markAllReadAction() {
  const r = await runAction(async () => notifications.markAllRead(await requireContext()));
  if (r.ok) revalidatePath('/app', 'layout');
  return r;
}
