import { Database } from "../types/db";

/**
 * Permission type from database schema
 */
export type Permission = Database["public"]["Enums"]["app_permission"];

/**
 * Permission constants for convenient access while maintaining type safety
 */
export const Permissions = {
  // App permissions
  APP_READ: "app.read" as const,
  APP_INSERT: "app.insert" as const,
  APP_UPDATE: "app.update" as const,
  APP_DELETE: "app.delete" as const,
  // Governs app-level publish policy (require_pull_request). Admin + owner only.
  APP_POLICY_UPDATE: "app_policy.update" as const,

  // API Key permissions
  API_KEY_READ: "api_key.read" as const,
  API_KEY_INSERT: "api_key.insert" as const,
  API_KEY_UPDATE: "api_key.update" as const,
  API_KEY_DELETE: "api_key.delete" as const,
  
  // Profile/User permissions — SELF-SERVICE. Every built-in role holds
  // profile.insert/update so a member can create and edit their OWN profile.
  // Never gate a privileged operation on these; use MEMBERSHIP_* instead.
  PROFILE_READ: "profile.read" as const,
  PROFILE_INSERT: "profile.insert" as const,
  PROFILE_UPDATE: "profile.update" as const,
  PROFILE_DELETE: "profile.delete" as const,

  // Member lifecycle — PRIVILEGED (owner/admin only). Inviting, changing a
  // role, disabling and removing. Separate from PROFILE_* because those are
  // held by every role and so cannot express an owner/admin boundary.
  MEMBERSHIP_READ: "membership.read" as const,
  MEMBERSHIP_INSERT: "membership.insert" as const,
  MEMBERSHIP_UPDATE: "membership.update" as const,
  MEMBERSHIP_DELETE: "membership.delete" as const,
  
  // Template permissions
  
  // Git connection permissions (GitHub)
  GIT_CONNECTION_READ: "git_connection.read" as const,
  GIT_CONNECTION_INSERT: "git_connection.insert" as const,
  GIT_CONNECTION_UPDATE: "git_connection.update" as const,
  GIT_CONNECTION_DELETE: "git_connection.delete" as const,

  // App member role permissions (per-app role management)
  APP_MEMBER_ROLE_READ: "app_member_role.read" as const,
  APP_MEMBER_ROLE_INSERT: "app_member_role.insert" as const,
  APP_MEMBER_ROLE_UPDATE: "app_member_role.update" as const,
  APP_MEMBER_ROLE_DELETE: "app_member_role.delete" as const,

  // Trace permissions (non-RLS, checked via app_authorize in API routes)
  TRACE_READ: "trace.read" as const,

  // Non-RLS, checked via app_authorize in server actions. Keeps the enum's
  // `experiment.*` family name; the surface it gates is Benchmarks.
  EXPERIMENT_READ: "experiment.read" as const,

  // Dataset permissions (separate from template; datasets are a distinct
  // app_permission family in 01-types.sql even though they share the
  // `template` storage table).

  // Tenant audit trail (read-only by design: the trail is written exclusively
  // by service_role, so no insert/update/delete permissions exist).
  AUDIT_LOG_READ: "audit_log.read" as const,

  // Context layer permissions (OuterLayer `.outerlayer/` mirror + editor).
  // Sync/mirror reads gate on context.read; saves (context-core save path,
  // later phases) require context.insert/.update/.delete as appropriate.
  CONTEXT_READ: "context.read" as const,
  CONTEXT_INSERT: "context.insert" as const,
  CONTEXT_UPDATE: "context.update" as const,
  CONTEXT_DELETE: "context.delete" as const,

  // Agent sessions (actor privacy). Self-by-default: `self.read` is
  // every active role's view of their OWN sessions; `team.read` (other
  // developers' sessions + transcripts) is admin-granted. Findings are
  // team-level aggregates; settings governs agents/capture-tier config.
  AGENTS_SESSIONS_SELF_READ: "agents.sessions.self.read" as const,
  AGENTS_SESSIONS_TEAM_READ: "agents.sessions.team.read" as const,
  AGENTS_FINDINGS_READ: "agents.findings.read" as const,
  AGENTS_SETTINGS_WRITE: "agents.settings.write" as const,

  // SSO permissions (enterprise SAML config — owner/admin only; delete is
  // owner-only). Mirrors the role_permissions seed in schemas/65-sso.sql. The
  // sso_config write server actions gate on these because they persist through
  // the service-role client, which bypasses the 65-sso.sql RLS.
  SSO_CONFIG_READ: "sso_config.read" as const,
  SSO_CONFIG_INSERT: "sso_config.insert" as const,
  SSO_CONFIG_UPDATE: "sso_config.update" as const,
  SSO_CONFIG_DELETE: "sso_config.delete" as const,

  // Custom-role permissions (owner/admin only — mirrors the role_permissions
  // seed in 12-rbac.sql). RLS on `custom_role` already enforces
  // `authorize('custom_role.*')`; these formalize the same gate in the
  // action layer so a denial surfaces as a clean FORBIDDEN result instead of
  // a read-role member reaching the DB and hitting a raw RLS error.
  CUSTOM_ROLE_READ: "custom_role.read" as const,
  CUSTOM_ROLE_INSERT: "custom_role.insert" as const,
  CUSTOM_ROLE_UPDATE: "custom_role.update" as const,
  CUSTOM_ROLE_DELETE: "custom_role.delete" as const,
} satisfies Record<string, Permission>;

/**
 * Platform-level permission constants for platform admin operations.
 * These permissions are granted to users with the 'platform_admin' role.
 */
export const PlatformPermissions = {
  ORG_READ: 'platform.org_read',
  ORG_DELETE: 'platform.org_delete',
  USER_READ: 'platform.user_read',
  USER_DELETE: 'platform.user_delete',
  TEMP_ACCESS_GRANT: 'platform.temp_access_grant',
  FLAG_MANAGE: 'platform.flag_manage',
  AUDIT_READ: 'platform.audit_read',
} as const;

export type PlatformPermission = typeof PlatformPermissions[keyof typeof PlatformPermissions];

// ---------------------------------------------------------------------------
// Permission Groups for Custom Role UI
// ---------------------------------------------------------------------------
// Feature grouping is a UI-only concern. The DB stores old-style table-level
// permissions (e.g. 'app.read', 'template.insert'). Each permission entry
// maps a human-friendly toggle to the actual DB-level permissions it grants.
// When creating a custom role, dbPermissions are expanded and stored.
// When loading a custom role, stored permissions are reverse-mapped to keys.
// ---------------------------------------------------------------------------

type PermissionEntry = {
  key: string;
  displayName: string;
  dbPermissions: string[];
  entitlementGate?: string;
  /**
   * When true, dbPermissionsToKeys checks this entry once its FIRST
   * dbPermission (the anchor) is present, without requiring the rest.
   * Reserved for entries whose trailing db permissions can land in the
   * database later than the anchor for an already-stored role (e.g. a
   * backfill migration pairing a second permission onto an existing grant)
   * — without this, an admin editing the role between the two writes would
   * see the toggle silently uncheck, and saving would then drop the anchor
   * permission the toggle already represented.
   */
  checkOnPartialMatch?: boolean;
};

type PermissionGroup = {
  label: string;
  permissions: PermissionEntry[];
  entitlementGate?: string;
};

/**
 * Permissions auto-granted to every custom role (not shown in the picker).
 * app.read is required for any meaningful app access. agents.sessions.self.read
 * mirrors the built-in-role seed ("self-by-default: every active role") —
 * every custom role sees its own agent sessions with no toggle to withhold
 * it; only team-wide read (`sessions_view_team`) is a picker choice.
 * environment.read is implicit for the same reason it is seeded to all four
 * built-in roles: the `environment` SELECT policy requires it, and an app's
 * environment is part of every app-scoped URL, so a role without it sees an
 * app with no environments rather than a restricted view. Environment
 * lifecycle (insert/update/delete/promote) stays unlisted and non-implicit —
 * it is grantable only through the built-in roles until that surface ships.
 * Nothing else is implicit: the enum declares values for tables that don't
 * exist, and those must not leak into the picker.
 */
export const IMPLICIT_DB_PERMISSIONS = [
  'app.read',
  'agents.sessions.self.read',
  'environment.read',
] as const;

export const PERMISSION_GROUPS: PermissionGroup[] = [
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
    // trace.read gates whether the trace-backed pages load at all. It is
    // distinct from the Agent Sessions group, which scopes WHOSE sessions are
    // visible — so this label deliberately avoids a bare "sessions".
    label: 'Observability',
    permissions: [
      { key: 'observability_view', displayName: 'View session traces, findings & topics', dbPermissions: ['trace.read'] },
    ],
    entitlementGate: 'traces_enabled',
  },
  {
    // There is no run toggle: experiment.run has no enforcement anywhere, so
    // it grants nothing. Benchmark dispatch is gated on eval_run.insert instead
    // (features/evals/actions.ts), which has no picker toggle of its own yet.
    // experiment.read is the Benchmarks nav gate and eval_run.read is the
    // data read (RLS on eval_run); they are separate permissions, so a role
    // holding only the first sees the nav item and an empty/denied page.
    label: 'Benchmarks',
    permissions: [
      // checkOnPartialMatch: a role stored with experiment.read alone still
      // renders this toggle checked, so an admin editing it doesn't watch it
      // silently uncheck and lose the grant entirely on the next save.
      { key: 'experiments_view', displayName: 'View benchmarks', dbPermissions: ['experiment.read', 'eval_run.read'], checkOnPartialMatch: true },
    ],
    entitlementGate: 'evals_enabled',
  },
  {
    // Context sync/mirror + editor (OuterLayer .outerlayer/ mirror).
    label: 'Context',
    permissions: [
      { key: 'context_view', displayName: 'View context files', dbPermissions: ['context.read'] },
      { key: 'context_manage', displayName: 'Edit context files', dbPermissions: ['context.insert', 'context.update', 'context.delete'] },
    ],
  },
  {
    // Cloud workers (worker_run rows: launch, cancel, and delete runs).
    label: 'Workers',
    permissions: [
      { key: 'workers_view', displayName: 'View worker runs', dbPermissions: ['worker_run.read'] },
      { key: 'workers_manage', displayName: 'Manage worker runs', dbPermissions: ['worker_run.insert', 'worker_run.update', 'worker_run.delete'] },
    ],
  },
  {
    // Agent sessions are self-by-default (every active role sees its own
    // sessions via the implicit agents.sessions.self.read grant — see
    // IMPLICIT_DB_PERMISSIONS). Team-wide read of other developers' sessions
    // and transcripts is the only toggle here.
    label: 'Agent Sessions',
    permissions: [
      { key: 'sessions_view_team', displayName: "View teammates' agent sessions", dbPermissions: ['agents.sessions.team.read'] },
    ],
  },
  {
    // Env-build escalation queue.
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
      // Read-only by design — the trail is written exclusively by service_role.
      { key: 'audit_log_view', displayName: 'View the organization audit log', dbPermissions: ['audit_log.read'] },
    ],
    entitlementGate: 'audit_log',
  },
];

export const PREREQUISITES: Record<string, string[]> = {
  'env_vars_manage': ['env_vars_view'],
  'api_keys_create': ['api_keys_view'],
  'api_keys_revoke': ['api_keys_view'],
  'dashboards_manage': ['analytics_view'],
  'git_manage': ['git_view'],
  'context_manage': ['context_view'],
  'workers_manage': ['workers_view'],
  'escalations_resolve': ['escalations_view'],
};

// ---------------------------------------------------------------------------
// Helpers: expand UI keys to DB permissions and reverse-map DB perms to keys
// ---------------------------------------------------------------------------

/** Build a map from key -> dbPermissions */
function buildKeyToDbPermsMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const group of PERMISSION_GROUPS) {
    for (const entry of group.permissions) {
      map.set(entry.key, entry.dbPermissions);
    }
  }
  return map;
}

const KEY_TO_DB_PERMS = buildKeyToDbPermsMap();

/**
 * Expand UI permission keys to DB-level permissions for storage.
 * Always includes IMPLICIT_DB_PERMISSIONS (app.read).
 * Used when creating/updating custom roles.
 */
export function expandKeysToDbPermissions(keys: string[]): string[] {
  const dbPerms = new Set<string>(IMPLICIT_DB_PERMISSIONS);
  for (const key of keys) {
    const perms = KEY_TO_DB_PERMS.get(key);
    if (perms) {
      for (const p of perms) dbPerms.add(p);
    }
  }
  return Array.from(dbPerms);
}

/**
 * Reverse-map DB-level permissions back to UI permission keys.
 * A key is included if ALL of its dbPermissions are present — unless the
 * entry opts into checkOnPartialMatch, in which case its first
 * (anchor) dbPermission alone is enough.
 * Used when loading a custom role for editing.
 */
export function dbPermissionsToKeys(dbPerms: string[]): string[] {
  const dbPermSet = new Set(dbPerms);
  const keys: string[] = [];
  for (const group of PERMISSION_GROUPS) {
    for (const entry of group.permissions) {
      const anchor = entry.dbPermissions[0];
      const matches = entry.checkOnPartialMatch
        ? anchor !== undefined && dbPermSet.has(anchor)
        : entry.dbPermissions.every((p) => dbPermSet.has(p));
      if (matches) {
        keys.push(entry.key);
      }
    }
  }
  return keys;
}
