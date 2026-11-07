'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as properties from './index';

type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};
/** Only the named fields are read; an org id, code, creator or timestamp in the form is ignored. */
const pick = (fd: FormData, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, str(fd, k)]));
const FIELDS = [
  'title',
  'listingType',
  'propertyType',
  'bhk',
  'city',
  'locality',
  'addressLine',
  'latitude',
  'longitude',
  'price',
  'priceType',
  'maintenance',
  'deposit',
  'carpetAreaSqft',
  'builtUpAreaSqft',
  'floor',
  'facing',
  'furnishing',
  'amenities',
  'responsibleUserId',
  'availableFrom',
  'description',
] as const;
const fields = (fd: FormData) => {
  const v = pick(fd, FIELDS);
  const status = str(fd, 'status');
  return status ? { ...v, status } : v;
};
const isId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

/** FR-140: a new property; on success, its page. */
export async function createPropertyAction(_: R | null, fd: FormData) {
  const r = await runAction(async () =>
    properties.createProperty(await requireContext(), fields(fd)),
  );
  if (!r.ok) return r;
  revalidatePath('/app/properties');
  redirect(`/app/properties/${r.data.id}`);
}

/** FR-140: edit a property. */
export async function updatePropertyAction(_: R | null, fd: FormData) {
  const id = str(fd, 'propertyId');
  const r = await runAction(async () =>
    properties.updateProperty(await requireContext(), id, {
      ...fields(fd),
      version: str(fd, 'version'),
    }),
  );
  if (r.ok && isId(id)) {
    revalidatePath(`/app/properties/${id}`);
    revalidatePath('/app/properties');
  }
  return r;
}

/** FR-142: show a property's contacts (audited each time). */
export async function revealContactsAction(_: R | null, fd: FormData) {
  return runAction(async () =>
    properties.revealContacts(await requireContext(), str(fd, 'propertyId')),
  );
}

/** FR-142: add a contact. */
export async function addContactAction(_: R | null, fd: FormData) {
  return runAction(async () =>
    properties.addContact(
      await requireContext(),
      str(fd, 'propertyId'),
      pick(fd, ['name', 'phone', 'email', 'relationship']),
    ),
  );
}

/** FR-142: remove a contact. */
export async function removeContactAction(_: R | null, fd: FormData) {
  return runAction(async () =>
    properties.removeContact(await requireContext(), str(fd, 'contactId')),
  );
}
