'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requestHeaders, requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as members from './index';

const PATH = '/app/settings/members';
type R = ActionResult<unknown>;

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};

async function done<T>(r: ActionResult<T>): Promise<ActionResult<T>> {
  if (r.ok) revalidatePath(PATH);
  return r;
}

export async function inviteMemberAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () => {
      const ctx = await requireContext();
      return members.inviteMember(ctx, await requestHeaders(), {
        email: str(fd, 'email'),
        role: str(fd, 'role'),
        teamId: str(fd, 'teamId'),
      });
    }),
  );
}

export async function cancelInvitationAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      members.cancelInvitation(
        await requireContext(),
        await requestHeaders(),
        str(fd, 'invitationId'),
      ),
    ),
  );
}

export async function changeRoleAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      members.changeRole(
        await requireContext(),
        await requestHeaders(),
        str(fd, 'membershipId'),
        str(fd, 'role'),
      ),
    ),
  );
}

export async function suspendMemberAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      members.suspendMember(await requireContext(), str(fd, 'membershipId')),
    ),
  );
}

export async function deactivateMemberAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      members.deactivateMember(
        await requireContext(),
        str(fd, 'membershipId'),
        str(fd, 'handover'),
      ),
    ),
  );
}

export async function reactivateMemberAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      members.reactivateMember(await requireContext(), str(fd, 'membershipId')),
    ),
  );
}

export async function updateHrProfileAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      members.updateHrProfile(await requireContext(), str(fd, 'membershipId'), {
        employeeCode: str(fd, 'employeeCode'),
        designation: str(fd, 'designation'),
      }),
    ),
  );
}
