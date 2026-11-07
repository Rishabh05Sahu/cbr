'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as exportsModule from './index';

type R = ActionResult<unknown>;

/**
 * Owner-only export request for the lead list filters in "query" (the list's own URL query
 * string). The server parses and validates every parameter exactly as the list does.
 */
export async function requestExportAction(_: R | null, fd: FormData) {
  const raw = fd.get('query');
  const params: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(typeof raw === 'string' ? raw : '')) {
    const prev = params[k];
    params[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  const r = await runAction(async () =>
    exportsModule.requestLeadExport(await requireContext(), params),
  );
  if (r.ok) revalidatePath('/app/leads/exports');
  return r;
}
