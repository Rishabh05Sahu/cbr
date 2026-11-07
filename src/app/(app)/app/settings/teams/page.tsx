import { ActionForm } from '@/components/action-form';
import { ActionFormButton } from '@/components/action-form-button';
import { Badge, Card, EmptyState, Field, Input, PageHeader, Select } from '@/components/ui';
import { listMembers } from '@/modules/members';
import { listTeams } from '@/modules/teams';
import {
  addTeamMemberAction,
  archiveTeamAction,
  createTeamAction,
  removeTeamMemberAction,
  setTeamRoleAction,
} from '@/modules/teams/actions';
import { pageContext } from '@/platform/auth/session';
import { can } from '@/platform/authz';

export default async function TeamsPage() {
  const { ctx } = await pageContext();
  const teams = await listTeams(ctx);
  const manage = can(ctx, 'team.manage');
  const people = manage ? (await listMembers(ctx)).filter((m) => m.status === 'ACTIVE') : [];

  return (
    <>
      <PageHeader
        title="Teams"
        description="Team leads see their team's work. Team history is kept when people move."
      />
      <div className="space-y-6">
        {manage && (
          <Card title="New team">
            <ActionForm
              action={createTeamAction}
              submitLabel="Create team"
              successMessage="Team created."
              className="grid gap-4 sm:grid-cols-3 sm:items-end"
            >
              <Field label="Name" htmlFor="team-name">
                <Input id="team-name" name="name" required minLength={2} maxLength={80} />
              </Field>
              <Field label="Description (optional)" htmlFor="team-desc">
                <Input id="team-desc" name="description" maxLength={500} />
              </Field>
            </ActionForm>
          </Card>
        )}
        {teams.length === 0 && <EmptyState>No teams to show.</EmptyState>}
        {teams.map((t) => {
          const inTeam = new Set(t.members.map((m) => m.membershipId));
          return (
            <Card
              key={t.id}
              title={t.name}
              {...(t.description ? { description: t.description } : {})}
              {...(manage
                ? {
                    actions: (
                      <ActionFormButton
                        action={archiveTeamAction}
                        fields={{ teamId: t.id }}
                        label="Archive"
                        variant="ghost"
                        confirm={`Archive ${t.name}? Members will be removed from it.`}
                      />
                    ),
                  }
                : {})}
            >
              {t.members.length === 0 ? (
                <p className="text-sm text-slate-500">No members yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {t.members.map((m) => (
                    <li
                      key={m.spellId}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span>
                        {m.name} {m.teamRole === 'LEAD' && <Badge tone="good">Team lead</Badge>}
                      </span>
                      {manage && (
                        <span className="flex gap-2">
                          <ActionFormButton
                            action={setTeamRoleAction}
                            fields={{
                              spellId: m.spellId,
                              teamRole: m.teamRole === 'LEAD' ? 'MEMBER' : 'LEAD',
                            }}
                            label={m.teamRole === 'LEAD' ? 'Make member' : 'Make lead'}
                            variant="ghost"
                          />
                          <ActionFormButton
                            action={removeTeamMemberAction}
                            fields={{ spellId: m.spellId }}
                            label="Remove"
                            variant="ghost"
                          />
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {manage && (
                <ActionForm
                  action={addTeamMemberAction}
                  submitLabel="Add"
                  className="mt-4 flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="teamId" value={t.id} />
                  <div className="min-w-48 flex-1">
                    <Field label="Add person" htmlFor={`add-${t.id}`}>
                      <Select id={`add-${t.id}`} name="membershipId" required defaultValue="">
                        <option value="" disabled>
                          Choose…
                        </option>
                        {people
                          .filter((p) => !inTeam.has(p.membershipId))
                          .map((p) => (
                            <option key={p.membershipId} value={p.membershipId}>
                              {p.name}
                            </option>
                          ))}
                      </Select>
                    </Field>
                  </div>
                  <div>
                    <Field label="As" htmlFor={`as-${t.id}`}>
                      <Select id={`as-${t.id}`} name="teamRole" defaultValue="MEMBER">
                        <option value="MEMBER">Member</option>
                        <option value="LEAD">Team lead</option>
                      </Select>
                    </Field>
                  </div>
                </ActionForm>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
