import { ActionForm } from '@/components/action-form';
import { ActionFormButton } from '@/components/action-form-button';
import { Badge, Card, EmptyState, Field, Input, PageHeader, Select } from '@/components/ui';
import { assignmentTargets, openLeadCounts } from '@/modules/leads';
import * as members from '@/modules/members';
import {
  cancelInvitationAction,
  changeRoleAction,
  deactivateMemberAction,
  inviteMemberAction,
  reactivateMemberAction,
  suspendMemberAction,
  updateHrProfileAction,
} from '@/modules/members/actions';
import { listTeams } from '@/modules/teams';
import { PLUGIN_ROLES } from '@/platform/auth/roles';
import { pageContext } from '@/platform/auth/session';
import { can, isOwner, scopeOf } from '@/platform/authz';
import { roleLabel } from '@/platform/email/templates';

const dateFmt = (d: Date) =>
  d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });

export default async function MembersPage() {
  const { ctx } = await pageContext();
  const rows = await members.listMembers(ctx);
  const mayInvite = can(ctx, 'user.invite');
  const invitations = mayInvite ? await members.listPendingInvitations(ctx) : [];
  const teams = mayInvite ? await listTeams(ctx) : [];
  const owner = isOwner(ctx);
  const grantable = PLUGIN_ROLES.filter((r) => owner || (r !== 'owner' && r !== 'admin'));
  const mayChangeRole = can(ctx, 'user.change_role');
  const maySuspend = can(ctx, 'user.suspend');
  const mayHr = can(ctx, 'user.update_hr_profile');
  // FR-077: people who still own open leads need a handover choice before removal.
  const handoverAware = maySuspend && scopeOf(ctx, 'lead.reassign') === 'ORG';
  const openLeads = handoverAware ? await openLeadCounts(ctx) : new Map<string, number>();
  const targets = handoverAware && openLeads.size ? await assignmentTargets(ctx) : null;
  const actsOn = (role: string) => owner || (role !== 'owner' && role !== 'admin');

  return (
    <>
      <PageHeader
        title="People"
        description="Members of this organisation, their roles and status."
      />
      <div className="space-y-6">
        {mayInvite && (
          <Card
            title="Invite someone"
            description="Invitations expire after 7 days. The person must sign in with the invited email address and confirm it."
          >
            <ActionForm
              action={inviteMemberAction}
              successMessage="Invitation sent."
              submitLabel="Send invitation"
              className="grid gap-4 sm:grid-cols-4 sm:items-end"
            >
              <Field label="Email" htmlFor="invite-email">
                <Input id="invite-email" name="email" type="email" required maxLength={254} />
              </Field>
              <Field label="Role" htmlFor="invite-role">
                <Select id="invite-role" name="role" defaultValue="sales_executive">
                  {grantable.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Team (optional)" htmlFor="invite-team">
                <Select id="invite-team" name="teamId" defaultValue="">
                  <option value="">No team</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </ActionForm>
          </Card>
        )}

        {mayInvite && (
          <Card title="Pending invitations">
            {invitations.length === 0 ? (
              <EmptyState>No pending invitations.</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {invitations.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {i.email} · {roleLabel(i.role ?? '')}
                      {i.teamName ? ` · ${i.teamName}` : ''} · expires {dateFmt(i.expiresAt)}
                    </span>
                    {actsOn(i.role ?? '') && (
                      <ActionFormButton
                        action={cancelInvitationAction}
                        fields={{ invitationId: i.id }}
                        label="Cancel"
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card title={`Members (${rows.length})`}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Role</th>
                  <th className="py-2 pr-4">Teams</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((m) => {
                  const self = m.userId === ctx.userId;
                  const manageable = !self && actsOn(m.role);
                  return (
                    <tr key={m.membershipId} className="align-top">
                      <td className="py-2 pr-4">
                        <p className="font-medium">{m.name}</p>
                        <p className="text-slate-600">{m.email}</p>
                        {(m.employeeCode || m.designation) && (
                          <p className="text-xs text-slate-500">
                            {[m.employeeCode, m.designation].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {mayChangeRole && manageable && m.status === 'ACTIVE' ? (
                          <ActionForm
                            action={changeRoleAction}
                            submitLabel="Change"
                            className="flex items-center gap-2"
                          >
                            <input type="hidden" name="membershipId" value={m.membershipId} />
                            <label className="sr-only" htmlFor={`role-${m.membershipId}`}>
                              Role for {m.name}
                            </label>
                            <Select
                              id={`role-${m.membershipId}`}
                              name="role"
                              defaultValue={m.role}
                              className="w-44"
                            >
                              {grantable.map((r) => (
                                <option key={r} value={r}>
                                  {roleLabel(r)}
                                </option>
                              ))}
                            </Select>
                          </ActionForm>
                        ) : (
                          roleLabel(m.role)
                        )}
                      </td>
                      <td className="py-2 pr-4">{m.teams.join(', ') || '—'}</td>
                      <td className="py-2 pr-4">
                        <Badge tone={m.status === 'ACTIVE' ? 'good' : 'warn'}>
                          {m.status.toLowerCase()}
                        </Badge>
                      </td>
                      <td className="space-y-2 py-2">
                        {maySuspend && manageable && (
                          <div className="flex flex-wrap gap-2">
                            {m.status === 'ACTIVE' ? (
                              <>
                                <ActionFormButton
                                  action={suspendMemberAction}
                                  fields={{ membershipId: m.membershipId }}
                                  label="Suspend"
                                  confirm={`Suspend ${m.name}? They will be signed out everywhere.`}
                                />
                                {(openLeads.get(m.userId) ?? 0) > 0 && targets ? (
                                  <ActionForm
                                    action={deactivateMemberAction}
                                    submitLabel="Hand over and remove"
                                    className="flex flex-wrap items-end gap-2"
                                  >
                                    <input
                                      type="hidden"
                                      name="membershipId"
                                      value={m.membershipId}
                                    />
                                    <p className="w-full text-xs text-slate-600">
                                      Their open follow-ups go with their leads; follow-ups on other
                                      people&apos;s leads go to each lead&apos;s owner.
                                    </p>
                                    <Field
                                      label={`${openLeads.get(m.userId)} open leads go to`}
                                      htmlFor={`handover-${m.membershipId}`}
                                    >
                                      <Select
                                        id={`handover-${m.membershipId}`}
                                        name="handover"
                                        required
                                        defaultValue=""
                                      >
                                        <option value="" disabled>
                                          Choose…
                                        </option>
                                        {targets.people
                                          .filter((p) => p.userId !== m.userId)
                                          .map((p) => (
                                            <option key={p.userId} value={`user:${p.userId}`}>
                                              {p.name}
                                            </option>
                                          ))}
                                        {targets.teams.map((t) => (
                                          <option key={t.id} value={`team:${t.id}`}>
                                            {t.name} queue
                                          </option>
                                        ))}
                                        <option value="queue">Organisation unassigned queue</option>
                                      </Select>
                                    </Field>
                                  </ActionForm>
                                ) : (
                                  <ActionFormButton
                                    action={deactivateMemberAction}
                                    fields={{ membershipId: m.membershipId }}
                                    label="Remove"
                                    variant="danger"
                                    confirm={`Remove ${m.name} from the organisation? They will be signed out and lose access.`}
                                  />
                                )}
                              </>
                            ) : (
                              <ActionFormButton
                                action={reactivateMemberAction}
                                fields={{ membershipId: m.membershipId }}
                                label="Reactivate"
                              />
                            )}
                          </div>
                        )}
                        {mayHr && (
                          <details>
                            <summary className="cursor-pointer text-xs text-slate-600">
                              HR details
                            </summary>
                            <ActionForm
                              action={updateHrProfileAction}
                              submitLabel="Save"
                              className="mt-2 space-y-2"
                            >
                              <input type="hidden" name="membershipId" value={m.membershipId} />
                              <Field label="Employee code" htmlFor={`ec-${m.membershipId}`}>
                                <Input
                                  id={`ec-${m.membershipId}`}
                                  name="employeeCode"
                                  defaultValue={m.employeeCode ?? ''}
                                  maxLength={40}
                                />
                              </Field>
                              <Field label="Designation" htmlFor={`ds-${m.membershipId}`}>
                                <Input
                                  id={`ds-${m.membershipId}`}
                                  name="designation"
                                  defaultValue={m.designation ?? ''}
                                  maxLength={80}
                                />
                              </Field>
                            </ActionForm>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
