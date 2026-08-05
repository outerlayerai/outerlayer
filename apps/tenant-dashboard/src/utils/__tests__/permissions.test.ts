/**
 * Unit Tests for Permissions Utilities
 *
 * Tests permission type definitions and constants.
 */

import { describe, it, expect } from 'vitest';
import { Permissions, PlatformPermissions, PERMISSION_GROUPS, PREREQUISITES, IMPLICIT_DB_PERMISSIONS, expandKeysToDbPermissions, dbPermissionsToKeys } from "../permissions";
import type { Permission, PlatformPermission } from "../permissions";
import { APP_PERMISSIONS, INTENTIONALLY_UNSEEDED } from "@repo/db-types/permissions";

describe("Permissions", () => {
  describe("permission constants", () => {
    it("should define app permissions correctly", () => {
      expect(Permissions.APP_READ).toBe("app.read");
      expect(Permissions.APP_INSERT).toBe("app.insert");
      expect(Permissions.APP_UPDATE).toBe("app.update");
      expect(Permissions.APP_DELETE).toBe("app.delete");
    });

    it("should define API key permissions correctly", () => {
      expect(Permissions.API_KEY_READ).toBe("api_key.read");
      expect(Permissions.API_KEY_INSERT).toBe("api_key.insert");
      expect(Permissions.API_KEY_UPDATE).toBe("api_key.update");
      expect(Permissions.API_KEY_DELETE).toBe("api_key.delete");
    });

    it("should define profile permissions correctly", () => {
      expect(Permissions.PROFILE_READ).toBe("profile.read");
      expect(Permissions.PROFILE_INSERT).toBe("profile.insert");
      expect(Permissions.PROFILE_UPDATE).toBe("profile.update");
      expect(Permissions.PROFILE_DELETE).toBe("profile.delete");
    });

    it("should define git connection permissions correctly", () => {
      expect(Permissions.GIT_CONNECTION_READ).toBe("git_connection.read");
      expect(Permissions.GIT_CONNECTION_INSERT).toBe("git_connection.insert");
      expect(Permissions.GIT_CONNECTION_UPDATE).toBe("git_connection.update");
      expect(Permissions.GIT_CONNECTION_DELETE).toBe("git_connection.delete");
    });
  });

  describe("permission structure", () => {
    it("should follow resource.action naming convention (verb LAST — scoped resources may dot-nest)", () => {
      const allPermissions = Object.values(Permissions);
      allPermissions.forEach((perm) => {
        // The resource may be a dotted path (e.g. `agents.sessions.self`),
        // but the FINAL segment is always the verb — permission-check.ts's
        // audit logic keys off `split('.').pop()`.
        expect(perm).toMatch(/^[a-z_]+(\.[a-z_]+)*\.(read|insert|update|delete|run|write)$/);
      });
    });

    it("should have unique permission values", () => {
      const values = Object.values(Permissions);
      const uniqueValues = new Set(values);
      expect(values.length).toBe(uniqueValues.size);
    });

    it("should have uppercase constant names", () => {
      const keys = Object.keys(Permissions);
      keys.forEach((key) => {
        expect(key).toMatch(/^[A-Z_]+$/);
      });
    });
  });

  describe("type safety", () => {
    it("should allow Permission type to accept valid permission strings", () => {
      const readPerm: Permission = "app.read";
      const insertPerm: Permission = "env_var.insert";
      const updatePerm: Permission = "profile.update";
      const deletePerm: Permission = "api_key.delete";

      expect(readPerm).toBe("app.read");
      expect(insertPerm).toBe("env_var.insert");
      expect(updatePerm).toBe("profile.update");
      expect(deletePerm).toBe("api_key.delete");
    });
  });
});

describe("PlatformPermissions", () => {
  describe("platform-level permission constants", () => {
    it("should define org permissions correctly", () => {
      expect(PlatformPermissions.ORG_READ).toBe("platform.org_read");
      expect(PlatformPermissions.ORG_DELETE).toBe("platform.org_delete");
    });

    it("should define user permissions correctly", () => {
      expect(PlatformPermissions.USER_READ).toBe("platform.user_read");
      expect(PlatformPermissions.USER_DELETE).toBe("platform.user_delete");
    });

    it("should define access and flag permissions correctly", () => {
      expect(PlatformPermissions.TEMP_ACCESS_GRANT).toBe("platform.temp_access_grant");
      expect(PlatformPermissions.FLAG_MANAGE).toBe("platform.flag_manage");
    });

    it("should define audit permission correctly", () => {
      expect(PlatformPermissions.AUDIT_READ).toBe("platform.audit_read");
    });
  });

  describe("platform permission structure", () => {
    it("should follow platform.action naming convention", () => {
      const allPlatformPermissions = Object.values(PlatformPermissions);
      allPlatformPermissions.forEach((perm) => {
        expect(perm).toMatch(/^platform\.[a-z_]+$/);
      });
    });

    it("should have unique permission values", () => {
      const values = Object.values(PlatformPermissions);
      const uniqueValues = new Set(values);
      expect(values.length).toBe(uniqueValues.size);
    });

    it("should have uppercase constant names", () => {
      const keys = Object.keys(PlatformPermissions);
      keys.forEach((key) => {
        expect(key).toMatch(/^[A-Z_]+$/);
      });
    });
  });

  describe("type safety", () => {
    it("should allow PlatformPermission type to accept valid platform permission strings", () => {
      const orgReadPerm: PlatformPermission = "platform.org_read";
      const userDeletePerm: PlatformPermission = "platform.user_delete";
      const flagManagePerm: PlatformPermission = "platform.flag_manage";

      expect(orgReadPerm).toBe("platform.org_read");
      expect(userDeletePerm).toBe("platform.user_delete");
      expect(flagManagePerm).toBe("platform.flag_manage");
    });
  });

  describe("separation from tenant permissions", () => {
    it("should not overlap with tenant-level permissions", () => {
      const tenantPermissions = new Set(Object.values(Permissions));
      const platformPermissions = new Set(Object.values(PlatformPermissions));

      const tenantArray = Array.from(tenantPermissions);
      const platformArray = Array.from(platformPermissions);

      const overlap = tenantArray.filter((perm) => platformArray.includes(perm as any));

      expect(overlap.length).toBe(0);
    });
  });
});

// Positional pin of the entire PERMISSION_GROUPS shape. Any re-introduction
// of a retired toggle (prompts_datasets_view/manage, traces_annotate,
// experiments_run, alerts_view/manage, webhook_view/manage, slack_view/manage)
// or drift in a new group's keys/dbPermissions/entitlement gates fails this
// test.
describe("PERMISSION_GROUPS (full-shape pin)", () => {
  it("matches the current shape exactly: retired entries absent, new groups exact", () => {
    expect(PERMISSION_GROUPS).toEqual([
      {
        label: 'App Management',
        permissions: [
          { key: 'apps_create', displayName: 'Create & edit apps', dbPermissions: ['app.insert', 'app.update'] },
          { key: 'apps_delete', displayName: 'Delete apps', dbPermissions: ['app.delete'] },
        ],
      },
      {
        label: 'Environment Variables',
        permissions: [
          { key: 'env_vars_view', displayName: 'View environment variables', dbPermissions: ['env_var.read'] },
          { key: 'env_vars_manage', displayName: 'Manage environment variables', dbPermissions: ['env_var.insert', 'env_var.update', 'env_var.delete'] },
        ],
      },
      {
        label: 'Observability',
        permissions: [
          { key: 'observability_view', displayName: 'View session traces, findings & topics', dbPermissions: ['trace.read'] },
        ],
        entitlementGate: 'traces_enabled',
      },
      {
        label: 'Benchmarks',
        permissions: [
          { key: 'experiments_view', displayName: 'View benchmarks', dbPermissions: ['experiment.read', 'eval_run.read'], checkOnPartialMatch: true },
        ],
        entitlementGate: 'evals_enabled',
      },
      {
        label: 'Context',
        permissions: [
          { key: 'context_view', displayName: 'View context files', dbPermissions: ['context.read'] },
          { key: 'context_manage', displayName: 'Edit context files', dbPermissions: ['context.insert', 'context.update', 'context.delete'] },
        ],
      },
      {
        label: 'Workers',
        permissions: [
          { key: 'workers_view', displayName: 'View worker runs', dbPermissions: ['worker_run.read'] },
          { key: 'workers_manage', displayName: 'Manage worker runs', dbPermissions: ['worker_run.insert', 'worker_run.update', 'worker_run.delete'] },
        ],
      },
      {
        label: 'Agent Sessions',
        permissions: [
          { key: 'sessions_view_team', displayName: "View teammates' agent sessions", dbPermissions: ['agents.sessions.team.read'] },
        ],
      },
      {
        label: 'Escalations',
        permissions: [
          { key: 'escalations_view', displayName: 'View escalations', dbPermissions: ['env_escalation.read'] },
          { key: 'escalations_resolve', displayName: 'Resolve escalations', dbPermissions: ['env_escalation.update'] },
        ],
      },
      {
        label: 'API Keys',
        permissions: [
          { key: 'api_keys_view', displayName: 'View API keys', dbPermissions: ['api_key.read'] },
          { key: 'api_keys_create', displayName: 'Create API keys', dbPermissions: ['api_key.insert'] },
          { key: 'api_keys_revoke', displayName: 'Revoke API keys', dbPermissions: ['api_key.delete', 'api_key.update'] },
        ],
      },
      {
        label: 'Analytics',
        permissions: [
          { key: 'analytics_view', displayName: 'View analytics', dbPermissions: ['dashboard.read'] },
          { key: 'dashboards_manage', displayName: 'Manage dashboards', dbPermissions: ['dashboard.insert', 'dashboard.update', 'dashboard.delete'] },
        ],
        entitlementGate: 'metrics_dashboard',
      },
      {
        label: 'Integrations',
        permissions: [
          { key: 'git_view', displayName: 'View git connections', dbPermissions: ['git_connection.read', 'git_branch.read'], entitlementGate: 'git_integration' },
          { key: 'git_manage', displayName: 'Manage git connections', dbPermissions: ['git_connection.insert', 'git_connection.update', 'git_connection.delete', 'git_branch.insert', 'git_branch.update', 'git_branch.delete'], entitlementGate: 'git_integration' },
        ],
      },
      {
        label: 'Audit',
        permissions: [
          { key: 'audit_log_view', displayName: 'View the organization audit log', dbPermissions: ['audit_log.read'] },
        ],
        entitlementGate: 'audit_log',
      },
    ]);
  });

  it("has no Prompts & Datasets group and grants no template.*/dataset.* permission (both dead: the tables don't exist)", () => {
    const labels = PERMISSION_GROUPS.map((g) => g.label);
    expect(labels).not.toContain('Prompts & Datasets');
    const allDbPerms = PERMISSION_GROUPS.flatMap((g) => g.permissions.flatMap((p) => p.dbPermissions));
    expect(allDbPerms.some((p) => p.startsWith('template.'))).toBe(false);
    expect(allDbPerms.some((p) => p.startsWith('dataset.'))).toBe(false);
  });

  it("has no traces_annotate toggle and grants no annotations.* permission (neither has an RLS policy or code call site)", () => {
    const allKeys = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
    expect(allKeys).not.toContain('traces_annotate');
    const allDbPerms = PERMISSION_GROUPS.flatMap((g) => g.permissions.flatMap((p) => p.dbPermissions));
    expect(allDbPerms.some((p) => p.startsWith('annotations.'))).toBe(false);
  });

  it("has no experiments_run toggle and grants no experiment.run permission (its only enforcement, pending_experiment, doesn't exist)", () => {
    const allKeys = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
    expect(allKeys).not.toContain('experiments_run');
    const allDbPerms = PERMISSION_GROUPS.flatMap((g) => g.permissions.flatMap((p) => p.dbPermissions));
    expect(allDbPerms).not.toContain('experiment.run');
  });

  it("should not contain a Deployments label or any deployment.* piggyback permission", () => {
    const labels = PERMISSION_GROUPS.map((g) => g.label);
    expect(labels).not.toContain('Deployments');
    const allDbPerms = PERMISSION_GROUPS.flatMap((g) => g.permissions.flatMap((p) => p.dbPermissions));
    expect(allDbPerms.some((p) => p.startsWith('deployment.'))).toBe(false);
  });

  it("should not contain puzzlet_config.* permissions (the table doesn't exist)", () => {
    const allDbPerms = PERMISSION_GROUPS.flatMap((g) => g.permissions.flatMap((p) => p.dbPermissions));
    expect(allDbPerms.some((p) => p.startsWith('puzzlet_config.'))).toBe(false);
  });

  it("should not contain the Review Queues group or annotation_queue.* permissions (the table doesn't exist)", () => {
    const labels = PERMISSION_GROUPS.map((g) => g.label);
    expect(labels).not.toContain('Review Queues');
    const allDbPerms = PERMISSION_GROUPS.flatMap((g) => g.permissions.flatMap((p) => p.dbPermissions));
    expect(allDbPerms.some((p) => p.startsWith('annotation_queue.'))).toBe(false);
  });

  it("should not contain App Access group (app.read is implicit)", () => {
    const labels = PERMISSION_GROUPS.map((g) => g.label);
    expect(labels).not.toContain('App Access');
  });

  it("should not contain AdminGuard-blocked groups (Members, Billing, Org Settings, SSO, Custom Roles)", () => {
    const labels = PERMISSION_GROUPS.map((g) => g.label);
    expect(labels).not.toContain('Members');
    expect(labels).not.toContain('Billing');
    expect(labels).not.toContain('Organization Settings');
    expect(labels).not.toContain('SSO');
    expect(labels).not.toContain('Custom Roles');
  });

  it("should have unique keys across all groups", () => {
    const allKeys = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
    expect(allKeys.length).toBe(new Set(allKeys).size);
  });

  it("every entry should have at least one dbPermission", () => {
    for (const group of PERMISSION_GROUPS) {
      for (const entry of group.permissions) {
        expect(entry.dbPermissions.length).toBeGreaterThan(0);
      }
    }
  });

  it("dbPermissions should follow resource.action pattern (with run/promote exceptions and dot-nested resources)", () => {
    for (const group of PERMISSION_GROUPS) {
      for (const entry of group.permissions) {
        for (const perm of entry.dbPermissions) {
          expect(perm).toMatch(/^[a-z_]+(\.[a-z_]+)*\.(read|insert|update|delete|run|promote)$/);
        }
      }
    }
  });
});

// Disjointness invariant — no db permission appears in more than one
// picker entry, computed over PERMISSION_GROUPS rather than hand-listed.
describe("PERMISSION_GROUPS disjointness", () => {
  it("no db permission appears in more than one picker entry", () => {
    const owners = new Map<string, string>();
    const violations: string[] = [];
    for (const group of PERMISSION_GROUPS) {
      for (const entry of group.permissions) {
        for (const perm of entry.dbPermissions) {
          const existing = owners.get(perm);
          if (existing && existing !== entry.key) {
            violations.push(`${perm} appears in both ${existing} and ${entry.key}`);
          } else {
            owners.set(perm, entry.key);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// Every PREREQUISITES key and value exists as a picker key — catches the
// dangling prerequisite class (e.g. the retired prompts_datasets_view
// dependency) permanently.
describe("PREREQUISITES (every key and value resolves to a real picker entry)", () => {
  const allKeys = new Set(PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key)));

  it("every PREREQUISITES key exists as a key in PERMISSION_GROUPS", () => {
    for (const key of Object.keys(PREREQUISITES)) {
      expect(allKeys.has(key), `PREREQUISITES key '${key}' not found in PERMISSION_GROUPS`).toBe(true);
    }
  });

  it("every PREREQUISITES value exists as a key in PERMISSION_GROUPS", () => {
    for (const [prereqKey, prereqValues] of Object.entries(PREREQUISITES)) {
      for (const val of prereqValues) {
        expect(allKeys.has(val), `PREREQUISITES['${prereqKey}'] value '${val}' not found in PERMISSION_GROUPS`).toBe(true);
      }
    }
  });

  it("should not reference app_access (it is implicit for all roles)", () => {
    expect(Object.keys(PREREQUISITES)).not.toContain('app_access');
    for (const prereqs of Object.values(PREREQUISITES)) {
      expect(prereqs).not.toContain('app_access');
    }
  });

  it("experiments_view has no prerequisite", () => {
    expect(PREREQUISITES['experiments_view']).toBeUndefined();
  });

  it("experiments_run has no PREREQUISITES row (it isn't a picker key)", () => {
    expect(PREREQUISITES['experiments_run']).toBeUndefined();
  });

  it("pins the three new-group prerequisite rows (context_manage, workers_manage, escalations_resolve)", () => {
    expect(PREREQUISITES['context_manage']).toEqual(['context_view']);
    expect(PREREQUISITES['workers_manage']).toEqual(['workers_view']);
    expect(PREREQUISITES['escalations_resolve']).toEqual(['escalations_view']);
  });
});

// expandKeysToDbPermissions over each new group key returns the exact
// documented set plus implicit permissions (positional).
describe("expandKeysToDbPermissions over the new Context/Workers/Agent Sessions/Escalations groups", () => {
  it("context_view expands to context.read plus implicit perms", () => {
    expect(expandKeysToDbPermissions(['context_view']).sort()).toEqual(
      ['agents.sessions.self.read', 'app.read', 'context.read', 'environment.read'].sort(),
    );
  });

  it("context_manage expands to the three context write perms plus implicit perms", () => {
    expect(expandKeysToDbPermissions(['context_manage']).sort()).toEqual(
      ['agents.sessions.self.read', 'app.read', 'context.delete', 'context.insert', 'context.update', 'environment.read'].sort(),
    );
  });

  it("workers_view expands to worker_run.read plus implicit perms", () => {
    expect(expandKeysToDbPermissions(['workers_view']).sort()).toEqual(
      ['agents.sessions.self.read', 'app.read', 'environment.read', 'worker_run.read'].sort(),
    );
  });

  it("workers_manage expands to the three worker_run write perms plus implicit perms", () => {
    expect(expandKeysToDbPermissions(['workers_manage']).sort()).toEqual(
      ['agents.sessions.self.read', 'app.read', 'environment.read', 'worker_run.delete', 'worker_run.insert', 'worker_run.update'].sort(),
    );
  });

  it("sessions_view_team expands to agents.sessions.team.read plus implicit perms", () => {
    expect(expandKeysToDbPermissions(['sessions_view_team']).sort()).toEqual(
      ['agents.sessions.self.read', 'agents.sessions.team.read', 'app.read', 'environment.read'].sort(),
    );
  });

  it("escalations_view expands to env_escalation.read plus implicit perms", () => {
    expect(expandKeysToDbPermissions(['escalations_view']).sort()).toEqual(
      ['agents.sessions.self.read', 'app.read', 'env_escalation.read', 'environment.read'].sort(),
    );
  });

  it("escalations_resolve expands to env_escalation.update plus implicit perms", () => {
    expect(expandKeysToDbPermissions(['escalations_resolve']).sort()).toEqual(
      ['agents.sessions.self.read', 'app.read', 'env_escalation.update', 'environment.read'].sort(),
    );
  });

  it("experiments_view expands to experiment.read and eval_run.read plus implicit perms", () => {
    expect(expandKeysToDbPermissions(['experiments_view']).sort()).toEqual(
      ['agents.sessions.self.read', 'app.read', 'environment.read', 'eval_run.read', 'experiment.read'].sort(),
    );
  });
});

// Entitlement gating of surviving groups is unchanged by the permission cleanup.
describe("PERMISSION_GROUPS entitlement gates", () => {
  it("pins the exact gate for every group that carries one", () => {
    const gates = Object.fromEntries(
      PERMISSION_GROUPS.filter((g) => g.entitlementGate).map((g) => [g.label, g.entitlementGate]),
    );
    expect(gates).toEqual({
      Observability: 'traces_enabled',
      Benchmarks: 'evals_enabled',
      Analytics: 'metrics_dashboard',
      Audit: 'audit_log',
    });
  });

  it("pins the exact per-entry gates inside Integrations (git_integration)", () => {
    const integrations = PERMISSION_GROUPS.find((g) => g.label === 'Integrations')!;
    const entryGates = Object.fromEntries(
      integrations.permissions.map((p) => [p.key, p.entitlementGate]),
    );
    expect(entryGates).toEqual({
      git_view: 'git_integration',
      git_manage: 'git_integration',
    });
  });

  it("the new groups (Context, Workers, Agent Sessions, Escalations) carry no entitlement gate", () => {
    for (const label of ['Context', 'Workers', 'Agent Sessions', 'Escalations']) {
      const group = PERMISSION_GROUPS.find((g) => g.label === label)!;
      expect(group.entitlementGate).toBeUndefined();
    }
  });
});

describe("IMPLICIT_DB_PERMISSIONS", () => {
  it("includes app.read, agents.sessions.self.read and environment.read (all implicit for every custom role, none a picker toggle)", () => {
    expect(IMPLICIT_DB_PERMISSIONS).toEqual([
      "app.read",
      "agents.sessions.self.read",
      "environment.read",
    ]);
  });

  // The environment SELECT policy (52-environment.sql) gates on
  // environment.read, and an app's environment is part of every app-scoped
  // URL — a custom role without it loads an app whose environments are all
  // filtered away. Lifecycle write perms are deliberately NOT implicit.
  it("grants environment.read but no environment write/promote permission", () => {
    expect(IMPLICIT_DB_PERMISSIONS).toContain("environment.read");
    for (const perm of ["environment.insert", "environment.update", "environment.delete", "environment.promote"]) {
      expect(IMPLICIT_DB_PERMISSIONS).not.toContain(perm);
    }
  });

  // Environment lifecycle is grantable only through the built-in roles until
  // that surface ships, so no picker toggle may hand it to a custom role.
  it("exposes no environment lifecycle toggle anywhere in the picker", () => {
    const allDbPerms = PERMISSION_GROUPS.flatMap((g) =>
      g.permissions.flatMap((p) => p.dbPermissions)
    );
    expect(allDbPerms.filter((p) => p.startsWith("environment."))).toEqual([]);
    const allKeys = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
    expect(allKeys.filter((k) => k.startsWith("environments_"))).toEqual([]);
    expect(Object.keys(PREREQUISITES).filter((k) => k.startsWith("environments_"))).toEqual([]);
  });

  it("should not appear as a selectable toggle in PERMISSION_GROUPS", () => {
    const allDbPerms = PERMISSION_GROUPS.flatMap((g) =>
      g.permissions.flatMap((p) => p.dbPermissions)
    );
    for (const implicitPerm of IMPLICIT_DB_PERMISSIONS) {
      expect(allDbPerms).not.toContain(implicitPerm);
    }
  });
});

describe("expandKeysToDbPermissions", () => {
  it("should always include implicit permissions even with empty keys", () => {
    const result = expandKeysToDbPermissions([]);
    expect(result).toEqual(["app.read", "agents.sessions.self.read", "environment.read"]);
  });

  it("should include implicit permissions alongside expanded keys", () => {
    const result = expandKeysToDbPermissions(["observability_view"]);
    expect(result).toContain("app.read");
    expect(result).toContain("agents.sessions.self.read");
    expect(result).toContain("trace.read");
  });

  it("should expand env_vars_view/env_vars_manage to the mirrored env_var.* perms", () => {
    const viewResult = expandKeysToDbPermissions(["env_vars_view"]);
    expect(viewResult).toEqual(expect.arrayContaining(["env_var.read"]));

    const manageResult = expandKeysToDbPermissions(["env_vars_manage"]);
    expect(manageResult).toEqual(
      expect.arrayContaining(["env_var.insert", "env_var.update", "env_var.delete"]),
    );
  });

  it("should expand multiple keys and deduplicate", () => {
    const result = expandKeysToDbPermissions(["context_view", "context_manage"]);
    expect(result).toContain("context.read");
    expect(result).toContain("context.insert");
    expect(result).toContain("context.update");
    expect(result).toContain("context.delete");
    expect(result.length).toBe(new Set(result).size);
  });

  it("should return only implicit permissions for unknown keys", () => {
    const result = expandKeysToDbPermissions(["nonexistent_key"]);
    expect(result).toEqual(["app.read", "agents.sessions.self.read", "environment.read"]);
  });
});

describe("dbPermissionsToKeys", () => {
  it("should not reverse-map app_access (not present in PERMISSION_GROUPS)", () => {
    const keys = dbPermissionsToKeys(["app.read"]);
    expect(keys).not.toContain("app_access");
  });

  it("should not include a key when only some of its perms are present", () => {
    // context_manage requires context.insert AND context.update AND context.delete
    const keys = dbPermissionsToKeys(["context.insert"]);
    expect(keys).not.toContain("context_manage");
  });

  it("should include context_manage when all its perms are present", () => {
    const keys = dbPermissionsToKeys(["context.insert", "context.update", "context.delete"]);
    expect(keys).toContain("context_manage");
  });

  it("should return empty array for empty input", () => {
    expect(dbPermissionsToKeys([])).toEqual([]);
  });

  // Bijectivity over every picker key — expanding a single key and
  // reverse-mapping it recovers exactly that key, no extras.
  it("is bijective for every picker key in isolation", () => {
    const allKeys = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
    for (const key of allKeys) {
      const dbPerms = expandKeysToDbPermissions([key]);
      const recovered = dbPermissionsToKeys(dbPerms);
      expect(recovered, `bijectivity failed for '${key}'`).toEqual([key]);
    }
  });

  it("round-trip: expand all keys then reverse should recover all keys", () => {
    const allKeys = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
    const dbPerms = expandKeysToDbPermissions(allKeys);
    const recovered = dbPermissionsToKeys(dbPerms);
    for (const key of allKeys) {
      expect(recovered).toContain(key);
    }
  });

  // Stored grants containing dead/unmapped perms are ignored when
  // computing keys, and a re-save (strict replace) drops them — the
  // intended cleanup behavior for legacy custom_role_permission rows.
  it("dead/unmapped stored perms are dropped on reverse-map and on strict-replace re-save", () => {
    const stored = ["app.read", "template.read", "deployment.read", "context.read"];
    const keys = dbPermissionsToKeys(stored);
    expect(keys).toEqual(["context_view"]);

    // Strict replace on save: re-expanding the computed keys produces the
    // set without the dead rows.
    const resaved = expandKeysToDbPermissions(keys).sort();
    expect(resaved).toEqual(["agents.sessions.self.read", "app.read", "context.read", "environment.read"].sort());
  });

  // Backfill fidelity — a stored set matching the migration backfill for
  // experiments_view renders CHECKED, and re-saving preserves it exactly
  // (no silent loss of the paired eval_run.read grant).
  it("the backfilled experiment.read + eval_run.read set renders experiments_view checked and survives re-save", () => {
    const stored = ["app.read", "agents.sessions.self.read", "environment.read", "experiment.read", "eval_run.read"];
    const keys = dbPermissionsToKeys(stored);
    expect(keys).toEqual(["experiments_view"]);

    const resaved = expandKeysToDbPermissions(keys).sort();
    expect(resaved).toEqual(stored.sort());
  });

  // Deploy-order safety: a role that only has experiment.read (the shape
  // that exists between the dashboard deploying the paired-permission
  // toggle and the backfill migration adding eval_run.read to that role's
  // stored grants) still renders experiments_view CHECKED — the toggle
  // never appears to silently uncheck itself — and re-saving completes the
  // pair rather than dropping experiment.read.
  it("renders experiments_view checked from experiment.read alone (checkOnPartialMatch) and completes the pair on re-save", () => {
    const partiallyStored = ["app.read", "agents.sessions.self.read", "experiment.read"];
    const keys = dbPermissionsToKeys(partiallyStored);
    expect(keys).toEqual(["experiments_view"]);

    const resaved = expandKeysToDbPermissions(keys).sort();
    expect(resaved).toEqual(
      ["agents.sessions.self.read", "app.read", "environment.read", "eval_run.read", "experiment.read"].sort(),
    );
  });

  it("does not check experiments_view from eval_run.read alone (experiment.read is the anchor permission)", () => {
    const keys = dbPermissionsToKeys(["app.read", "agents.sessions.self.read", "eval_run.read"]);
    expect(keys).not.toContain("experiments_view");
  });
});

// General anti-drift invariant: every db permission the picker can grant
// (including the implicit ones) must be a live, seeded permission — never a
// retired/enum-compatibility-only value and never a typo the enum happens
// not to catch. Subsumes most of the individual "should not contain X.*"
// pins above; those stay as documentation of specifically which retirements
// this cleanup made, but this is the test that catches the NEXT one.
describe("picker permissions stay inside the live, seeded surface", () => {
  it("every PERMISSION_GROUPS + IMPLICIT_DB_PERMISSIONS entry is in APP_PERMISSIONS and not in INTENTIONALLY_UNSEEDED", () => {
    const pickerPerms = new Set<string>([
      ...IMPLICIT_DB_PERMISSIONS,
      ...PERMISSION_GROUPS.flatMap((g) => g.permissions.flatMap((p) => p.dbPermissions)),
    ]);
    const appPermissionSet = new Set<string>(APP_PERMISSIONS);
    const unseededSet = new Set<string>(INTENTIONALLY_UNSEEDED);

    const notLive = [...pickerPerms].filter((p) => !appPermissionSet.has(p)).sort();
    const retired = [...pickerPerms].filter((p) => unseededSet.has(p)).sort();

    expect(notLive).toEqual([]);
    expect(retired).toEqual([]);
  });
});
