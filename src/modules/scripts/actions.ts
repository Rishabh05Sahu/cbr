'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as scripts from './index';

type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};
const all = (fd: FormData, k: string) =>
  fd.getAll(k).filter((v): v is string => typeof v === 'string' && v !== '');

/** Refreshes the author and reader pages of one script. */
function refresh(id: string) {
  if (/^[0-9a-f-]{36}$/i.test(id)) revalidatePath(`/app/settings/scripts/${id}`);
  revalidatePath('/app/settings/scripts');
  revalidatePath('/app/scripts');
}

export async function createScriptAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    scripts.createScript(await requireContext(), { name: str(fd, 'name') }),
  );
  if (r.ok) {
    refresh(r.data.id);
    redirect(`/app/settings/scripts/${r.data.id}` as never);
  }
  return r;
}

export async function updateScriptSettingsAction(_: R | null, fd: FormData) {
  const id = str(fd, 'scriptId');
  const r = await runAction(async () =>
    scripts.updateScriptSettings(await requireContext(), id, {
      name: str(fd, 'name'),
      transactionTypes: all(fd, 'transactionTypes'),
      propertyTypes: all(fd, 'propertyTypes'),
      languages: str(fd, 'languages'),
      sourceIds: all(fd, 'sourceIds'),
      version: str(fd, 'version'),
    }),
  );
  if (r.ok) refresh(id);
  return r;
}

export async function saveDraftAction(_: R | null, fd: FormData) {
  const id = str(fd, 'scriptId');
  // Objection rows arrive as parallel lists (objection[i] pairs with response[i]).
  const objections = fd.getAll('objection').map((o, i) => ({
    objection: typeof o === 'string' ? o : '',
    response: (() => {
      const v = fd.getAll('response')[i];
      return typeof v === 'string' ? v : '';
    })(),
  }));
  const r = await runAction(async () =>
    scripts.saveDraft(await requireContext(), id, {
      opening: str(fd, 'opening'),
      questions: str(fd, 'questions'),
      pitch: str(fd, 'pitch'),
      closing: str(fd, 'closing'),
      objections,
      draftVersion: str(fd, 'draftVersion'),
    }),
  );
  if (r.ok) refresh(id);
  return r;
}

export async function publishScriptAction(_: R | null, fd: FormData) {
  const id = str(fd, 'scriptId');
  const r = await runAction(async () =>
    scripts.publishScript(await requireContext(), id, { draftVersion: str(fd, 'draftVersion') }),
  );
  if (r.ok) refresh(id);
  return r;
}

export async function archiveScriptAction(_: R | null, fd: FormData) {
  const id = str(fd, 'scriptId');
  const r = await runAction(async () =>
    scripts.archiveScript(await requireContext(), id, { version: str(fd, 'version') }),
  );
  if (r.ok) refresh(id);
  return r;
}
