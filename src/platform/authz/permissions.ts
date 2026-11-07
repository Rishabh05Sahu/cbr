// Permission catalog (ADR-0004) — Phase 1 subset of user-personas-and-roles §4, plus the
// Phase 2 lead permissions (§4.1: read, create, update, update_stage, timeline; M3: assign,
// reassign, assignment history; M4: import; M5: archive, delete, merge, bulk_update, export),
// plus the Phase 3 task permissions (§4.3: read, create for self, update/complete/reschedule)
// and script permissions (§4.2: read published, manage), plus FR-065 lifting Do-Not-Contact
// (setting a contact status is lead.update in the lead's scope), plus FR-060 phone reveal, plus
// the FR-083 interaction permissions (§4.2: create and read; edit is deferred).
// Fixed system roles; the matrix is code, reviewed like code. Later phases add codes here.
import type { RoleCode } from '@/platform/auth/roles';

export type Scope = 'OWN' | 'TEAM' | 'ORG';

export const PERMISSIONS = [
  'org.settings.read',
  'org.settings.manage',
  'org.security_policy.manage',
  'user.read',
  'user.invite',
  'user.suspend',
  'user.change_role',
  'user.remove',
  'user.update_hr_profile',
  'team.read',
  'team.manage',
  'profile.update_own',
  'audit.read',
  'support_access.approve',
  'lead.read',
  'lead.create',
  'lead.update',
  'lead.update_stage',
  'lead.view_activity_timeline',
  'lead.assign',
  'lead.reassign',
  'lead.view_assignment_history',
  'lead.import',
  'lead.archive',
  'lead.delete',
  'lead.merge',
  'lead.bulk_update',
  'lead.export',
  'lead.lift_do_not_contact',
  'lead.reveal_phone',
  'interaction.create',
  'interaction.read',
  'task.read',
  'task.create',
  // §4.3 'task.create for others' (FR-103): choose another member as the assignee.
  'task.assign',
  // FR-107: create and manage one's own recurring series (owner decision 2026-10-30).
  'task.recur',
  'task.update',
  'script.read',
  'script.manage',
  // §4.5 FR-140 / FR-142 (ADR-0021).
  'property.read',
  'property.manage',
  'property.read_owner_contact',
  // §4.3 FR-150–152 site visits (ADR-0022).
  'site_visit.read',
  'site_visit.manage',
  // §4.6 FR-130–133 dashboards (ADR-0023): O / O / T / S. HR's "leave reports only" waits for
  // leave reports (none exist yet), so HR has no report grant.
  'report.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

type Grants = Partial<Record<Permission, Scope>>;

const ORG_ADMIN_BASE: Grants = {
  // §4.5 properties (FR-140/142): Owner and Admin read, manage and see owner contacts.
  'property.read': 'ORG',
  'property.manage': 'ORG',
  'property.read_owner_contact': 'ORG',
  'report.read': 'ORG',
  'org.settings.read': 'ORG',
  'org.settings.manage': 'ORG',
  'user.read': 'ORG',
  'user.invite': 'ORG',
  'user.suspend': 'ORG',
  'user.change_role': 'ORG',
  'user.remove': 'ORG',
  'user.update_hr_profile': 'ORG',
  'team.read': 'ORG',
  'team.manage': 'ORG',
  'profile.update_own': 'OWN',
  'audit.read': 'ORG',
  ...leadGrants('ORG'),
  // §4.1: Owner/Admin O. Sales Manager is "cfg (imports into own teams)", off until an org
  // setting exists; Sales Executives, HR and support never import.
  'lead.import': 'ORG',
  // §4.1 (M5): archive/restore and bulk updates O/O, Sales Manager "T (cfg)" → off until an org
  // setting exists. Merge O/O/T. Export is Owner-only by default ("cfg" for Admin and Manager;
  // threat model T5: export off except Owner). Hard delete is Owner-only (OWNER below).
  'lead.archive': 'ORG',
  'lead.merge': 'ORG',
  'lead.bulk_update': 'ORG',
  // FR-065 (owner decision 2026-10-28, ADR-0012): only Owner/Admin lift Do-Not-Contact, with a
  // recorded consent basis and evidence. Anyone who may update the lead can set it.
  'lead.lift_do_not_contact': 'ORG',
  // §4.2 scripts: Owner/Admin read and manage (create, edit, publish, archive).
  'script.read': 'ORG',
  'script.manage': 'ORG',
};

/** Lead permissions share one scope per role in the §4.1 matrix (O / T / S). */
function leadGrants(scope: Scope): Grants {
  return {
    'lead.read': scope,
    'lead.create': scope,
    'lead.update': scope,
    'lead.update_stage': scope,
    'lead.view_activity_timeline': scope,
    'lead.view_assignment_history': scope,
    // §4.1 FR-060: reveal a masked number, O / O / T / S (only meaningful when masking is on).
    'lead.reveal_phone': scope,
    // §4.2 FR-083: log and read interactions, O / O / T / S (support: read with a grant, below).
    'interaction.create': scope,
    'interaction.read': scope,
    // §4.1: assign/reassign are O/O/T; Sales Executives never assign.
    ...(scope === 'OWN' ? {} : { 'lead.assign': scope, 'lead.reassign': scope }),
    ...taskGrants(scope),
    // §4.3 site visits follow the lead scope, O / O / T / S (read also covers visits assigned
    // to the caller, applied in the visits module).
    'site_visit.read': scope,
    'site_visit.manage': scope,
  };
}

/**
 * §4.3 tasks. Read and update/complete/reschedule are O / O / T / S ("assigned to me").
 * Creating is for oneself only in Phase 3 (OWN for every sales role); creating for others
 * (O / O / T) is `task.assign` (FR-103, ADR-0016): a Sales Executive assigns nobody. HR's own
 * non-lead tasks: see HR_OPS.
 */
function taskGrants(scope: Scope): Grants {
  return {
    'task.read': scope,
    'task.create': 'OWN',
    'task.update': scope,
    // FR-107 (ADR-0020): Owner, Admin and Sales Manager create recurring series of their OWN
    // no-lead tasks; Sales Executives and HR do not.
    ...(scope === 'OWN' ? {} : { 'task.assign': scope, 'task.recur': 'OWN' }),
  };
}

export const ROLE_GRANTS: Record<RoleCode, Grants> = {
  // Owner-only: security policy, support access (roles §2.3). Owner/Admin targets are
  // further restricted in the membership commands (Admins cannot act on Owners/Admins).
  OWNER: {
    ...ORG_ADMIN_BASE,
    'org.security_policy.manage': 'ORG',
    'support_access.approve': 'ORG',
    // Erasure requests only (FR-061) and exports (T5, export enablement is an Owner policy).
    'lead.delete': 'ORG',
    'lead.export': 'ORG',
  },
  ADMIN: { ...ORG_ADMIN_BASE },
  SALES_MANAGER: {
    'org.settings.read': 'ORG',
    'user.read': 'TEAM',
    'team.read': 'TEAM',
    'profile.update_own': 'OWN',
    ...leadGrants('TEAM'),
    'lead.merge': 'TEAM',
    'report.read': 'TEAM',
    // §4.5: read all properties and their owner contacts; property.manage is cfg (off).
    'property.read': 'ORG',
    'property.read_owner_contact': 'ORG',
    // §4.2: published scripts are org-wide reading. script.manage is "cfg" for managers and
    // stays off until an org setting exists.
    'script.read': 'ORG',
  },
  SALES_EXECUTIVE: {
    'org.settings.read': 'ORG',
    'user.read': 'OWN',
    'team.read': 'OWN',
    'profile.update_own': 'OWN',
    ...leadGrants('OWN'),
    'report.read': 'OWN',
    'script.read': 'ORG',
    // §4.5: non-confidential property fields; owner contacts and managing are cfg (off).
    'property.read': 'ORG',
  },
  // HR sees people (names, members, HR fields), never customer data (no lead.* grants).
  // `user.invite` and `user.suspend` for HR are "cfg" in the matrix and stay off until an org
  // setting exists.
  HR_OPS: {
    'org.settings.read': 'ORG',
    'user.read': 'ORG',
    'user.update_hr_profile': 'ORG',
    'team.read': 'ORG',
    'profile.update_own': 'OWN',
    // §4.3 (FR-100, ADR-0015): HR creates and updates their own non-lead tasks and, as everyone,
    // sees their own tasks (§2.2 "users' own tasks are always visible to them"). Without lead
    // grants a task on a lead is refused (createTask and loadForUpdate need lead.update).
    'task.read': 'OWN',
    'task.create': 'OWN',
    'task.update': 'OWN',
  },
};

/** Platform staff under an approved READ support grant: org-scoped, read-only. */
export const SUPPORT_READ_GRANTS: Grants = {
  'org.settings.read': 'ORG',
  'user.read': 'ORG',
  'team.read': 'ORG',
  'audit.read': 'ORG',
  // §4.1 "G": lead data and its timeline, read-only.
  'lead.read': 'ORG',
  'lead.view_activity_timeline': 'ORG',
  'lead.view_assignment_history': 'ORG',
  // §4.2 "G": interactions, read-only.
  'interaction.read': 'ORG',
};
