'use server';
import 'server-only';
import { revalidatePath } from 'next/cache';
import { requireContext } from '@/platform/auth/session';
import { runAction } from '@/platform/actions';
import type { ActionResult } from '@/platform/errors';
import * as teams from './index';

const PATH = '/app/settings/teams';
type R = ActionResult<unknown>;
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : '';
};
async function done<T>(r: ActionResult<T>): Promise<ActionResult<T>> {
  if (r.ok) revalidatePath(PATH);
  return r;
}

export async function createTeamAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      teams.createTeam(await requireContext(), {
        name: str(fd, 'name'),
        description: str(fd, 'description'),
      }),
    ),
  );
}

export async function renameTeamAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      teams.renameTeam(await requireContext(), str(fd, 'teamId'), {
        name: str(fd, 'name'),
        description: str(fd, 'description'),
      }),
    ),
  );
}

export async function archiveTeamAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () => teams.archiveTeam(await requireContext(), str(fd, 'teamId'))),
  );
}

export async function addTeamMemberAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      teams.addTeamMember(await requireContext(), {
        teamId: str(fd, 'teamId'),
        membershipId: str(fd, 'membershipId'),
        teamRole: str(fd, 'teamRole') || 'MEMBER',
      }),
    ),
  );
}

export async function removeTeamMemberAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () => teams.removeTeamMember(await requireContext(), str(fd, 'spellId'))),
  );
}

export async function setTeamRoleAction(_: R | null, fd: FormData) {
  return done(
    await runAction(async () =>
      teams.setTeamRole(await requireContext(), str(fd, 'spellId'), str(fd, 'teamRole')),
    ),
  );
}
