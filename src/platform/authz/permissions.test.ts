import { describe, expect, it } from 'vitest';
import { authorize, can, type RequestContext } from './index';
import { PERMISSIONS, ROLE_GRANTS } from './permissions';

const member = (role: keyof typeof ROLE_GRANTS): RequestContext => ({
  kind: 'member',
  userId: 'u',
  orgId: 'o',
  orgName: 'O',
  membershipId: 'm',
  role,
  pluginRole: 'owner',
  tenant: { orgId: 'o', userId: 'u' },
});

const support: RequestContext = {
  kind: 'support',
  userId: 'p',
  orgId: 'o',
  orgName: 'O',
  grantId: 'g',
  accessLevel: 'WRITE',
  tenant: { orgId: 'o', userId: 'p', readOnly: true },
};

// The approved matrix (user-personas-and-roles §4.4 + §2.3), Phase 1 subset.
const EXPECTED: Record<string, Record<string, string | null>> = {
  'user.invite': {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  },
  'user.suspend': {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  },
  'user.change_role': {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  },
  'team.manage': {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  },
  'team.read': {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: 'TEAM',
    SALES_EXECUTIVE: 'OWN',
    HR_OPS: 'ORG',
  },
  'user.read': {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: 'TEAM',
    SALES_EXECUTIVE: 'OWN',
    HR_OPS: 'ORG',
  },
  'org.settings.manage': {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  },
  'org.security_policy.manage': {
    OWNER: 'ORG',
    ADMIN: null,
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  },
  'support_access.approve': {
    OWNER: 'ORG',
    ADMIN: null,
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  },
  'audit.read': {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  },
};

// §4.1 (Phase 2 M1): Owner/Admin O, Sales Manager T, Sales Exec S, HR none.
for (const p of [
  'lead.read',
  'lead.create',
  'lead.update',
  'lead.update_stage',
  'lead.view_activity_timeline',
  'lead.reveal_phone',
])
  EXPECTED[p] = {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: 'TEAM',
    SALES_EXECUTIVE: 'OWN',
    HR_OPS: null,
  };
EXPECTED['lead.view_assignment_history'] = { ...EXPECTED['lead.read']! };
for (const p of ['lead.assign', 'lead.reassign'])
  EXPECTED[p] = {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: 'TEAM',
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  };
EXPECTED['lead.import'] = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: null,
  SALES_EXECUTIVE: null,
  HR_OPS: null,
};

// §4.1 (Phase 2 M5). "cfg" cells stay off until the org setting exists.
for (const p of ['lead.archive', 'lead.bulk_update'])
  EXPECTED[p] = {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  };
EXPECTED['lead.merge'] = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: 'TEAM',
  SALES_EXECUTIVE: null,
  HR_OPS: null,
};
for (const p of ['lead.delete', 'lead.export'])
  EXPECTED[p] = {
    OWNER: 'ORG',
    ADMIN: null,
    SALES_MANAGER: null,
    SALES_EXECUTIVE: null,
    HR_OPS: null,
  };

// FR-065 (ADR-0012): lifting Do-Not-Contact is Owner/Admin only (setting it is lead.update).
EXPECTED['lead.lift_do_not_contact'] = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: null,
  SALES_EXECUTIVE: null,
  HR_OPS: null,
};

// §4.3: read and update O / O / T / S; create is for oneself only until FR-103 (Phase 4); HR
// has their own non-lead tasks (FR-100, ADR-0015).
for (const p of ['task.read', 'task.update'])
  EXPECTED[p] = {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: 'TEAM',
    SALES_EXECUTIVE: 'OWN',
    HR_OPS: 'OWN',
  };
// §4.3 'task.create for others' (FR-103): O / O / T / — / —.
EXPECTED['task.assign'] = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: 'TEAM',
  SALES_EXECUTIVE: null,
  HR_OPS: null,
};
// FR-107 recurring series (owner decision 2026-10-30): Owner, Admin, Sales Manager, own only.
EXPECTED['task.recur'] = {
  OWNER: 'OWN',
  ADMIN: 'OWN',
  SALES_MANAGER: 'OWN',
  SALES_EXECUTIVE: null,
  HR_OPS: null,
};
EXPECTED['task.create'] = {
  OWNER: 'OWN',
  ADMIN: 'OWN',
  SALES_MANAGER: 'OWN',
  SALES_EXECUTIVE: 'OWN',
  HR_OPS: 'OWN',
};

// §4.5 properties (ADR-0021): read O / O / O / O; manage O / O / cfg (off) / cfg (off); owner
// contact O / O / O / cfg (off); HR none.
EXPECTED['property.read'] = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: 'ORG',
  SALES_EXECUTIVE: 'ORG',
  HR_OPS: null,
};
EXPECTED['property.manage'] = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: null,
  SALES_EXECUTIVE: null,
  HR_OPS: null,
};
EXPECTED['property.read_owner_contact'] = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: 'ORG',
  SALES_EXECUTIVE: null,
  HR_OPS: null,
};

// §4.3 site visits: read and manage O / O / T / S; HR none.
for (const p of ['site_visit.read', 'site_visit.manage'])
  EXPECTED[p] = {
    OWNER: 'ORG',
    ADMIN: 'ORG',
    SALES_MANAGER: 'TEAM',
    SALES_EXECUTIVE: 'OWN',
    HR_OPS: null,
  };

// §4.2 scripts: read (published) O / O / O / O; manage O / O / cfg (off) / —; HR none.
EXPECTED['script.read'] = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: 'ORG',
  SALES_EXECUTIVE: 'ORG',
  HR_OPS: null,
};
EXPECTED['script.manage'] = {
  OWNER: 'ORG',
  ADMIN: 'ORG',
  SALES_MANAGER: null,
  SALES_EXECUTIVE: null,
  HR_OPS: null,
};

describe('permission matrix', () => {
  for (const [permission, byRole] of Object.entries(EXPECTED)) {
    for (const [role, scope] of Object.entries(byRole)) {
      it(`${role} ${permission} -> ${scope ?? 'denied'}`, () => {
        const ctx = member(role as keyof typeof ROLE_GRANTS);
        if (scope === null) expect(() => authorize(ctx, permission as never)).toThrow(/permission/);
        else expect(authorize(ctx, permission as never)).toBe(scope);
      });
    }
  }

  it('every role can update its own profile', () => {
    for (const role of Object.keys(ROLE_GRANTS)) {
      expect(authorize(member(role as keyof typeof ROLE_GRANTS), 'profile.update_own')).toBe('OWN');
    }
  });

  it('support access is read-only even for a WRITE grant', () => {
    const writes = PERMISSIONS.filter((p) =>
      /manage|invite|suspend|change_role|remove|update|approve/.test(p),
    );
    for (const p of writes) expect(can(support, p), p).toBe(false);
    expect(can(support, 'user.read')).toBe(true);
    // §4.1 "G": leads and their timeline are readable, never writable.
    expect(can(support, 'lead.read')).toBe(true);
    expect(can(support, 'lead.view_activity_timeline')).toBe(true);
    expect(can(support, 'lead.create')).toBe(false);
    expect(can(support, 'lead.view_assignment_history')).toBe(true);
    expect(can(support, 'lead.assign')).toBe(false);
    expect(can(support, 'lead.reassign')).toBe(false);
    expect(can(support, 'lead.import')).toBe(false);
    for (const p of [
      'lead.archive',
      'lead.delete',
      'lead.merge',
      'lead.bulk_update',
      'lead.export',
      'lead.lift_do_not_contact',
      'lead.reveal_phone',
    ] as const)
      expect(can(support, p), p).toBe(false);
  });
});
