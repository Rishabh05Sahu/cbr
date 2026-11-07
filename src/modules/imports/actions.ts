'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as imports from './jobs';
import * as templates from './templates';

// Thin wrappers: every check (role, uploader, status, version, file) is in ./jobs.ts. Inputs are
// parsed there; the org, actor and timestamps always come from the server context.

const jobPath = (id: string) => `/app/leads/import/${id}`;

async function onJob<T>(id: unknown, fn: () => Promise<T>): Promise<ActionResult<T>> {
  const r = await runAction(fn);
  if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) revalidatePath(jobPath(id));
  revalidatePath('/app/leads/import');
  return r;
}

/** Returns the one-object upload permission for the browser's PUT (never logged). */
export async function startImportAction(input: unknown) {
  return onJob(null, async () => imports.startImport(await requireContext(), input));
}

export async function confirmUploadAction(id: unknown) {
  return onJob(id, async () => imports.confirmUpload(await requireContext(), id));
}

export async function chooseSheetAction(id: unknown, input: unknown) {
  return onJob(id, async () => imports.chooseSheet(await requireContext(), id, input));
}

export async function submitMappingAction(id: unknown, input: unknown) {
  return onJob(id, async () => imports.submitMapping(await requireContext(), id, input));
}

export async function confirmImportAction(id: unknown, input: unknown) {
  return onJob(id, async () => imports.confirmImport(await requireContext(), id, input));
}

export async function resumeImportAction(id: unknown) {
  return onJob(id, async () => imports.resumeImport(await requireContext(), id));
}

export async function cancelImportAction(id: unknown) {
  return onJob(id, async () => imports.cancelImport(await requireContext(), id));
}

// FR-041 mapping templates (./templates.ts). Form actions: only the named fields are read.
const field = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};

export async function saveMappingTemplateAction(_: ActionResult<unknown> | null, fd: FormData) {
  const importId = field(fd, 'importId');
  return onJob(importId, async () =>
    templates.saveMappingTemplate(await requireContext(), {
      importId,
      name: field(fd, 'name'),
      sourceId: field(fd, 'sourceId'),
    }),
  );
}

export async function deleteMappingTemplateAction(_: ActionResult<unknown> | null, fd: FormData) {
  return onJob(null, async () =>
    templates.deleteMappingTemplate(await requireContext(), field(fd, 'templateId')),
  );
}
