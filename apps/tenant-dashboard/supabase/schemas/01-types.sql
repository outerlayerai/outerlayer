-- =============================================================================
-- Types Schema
-- =============================================================================
-- Purpose: Enum types and custom types used throughout the application
-- Dependencies: 00-extensions.sql
-- Note: Enum value ORDER must match the database exactly
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Application Role System
-- -----------------------------------------------------------------------------

-- User roles within a tenant organization
-- Note: Order must match database for zero drift
-- `role` always holds a real built-in role; a custom role is active when
-- membership.custom_role_id / app_member_role.custom_role_id IS NOT NULL,
-- resolved at read time — there is no 'custom' sentinel in this enum.
CREATE TYPE public.app_role AS ENUM (
    'admin',
    'write',
    'read',
    'disabled',
    'owner'
);

-- Granular permissions for application resources
-- Note: Order must match database for zero drift
CREATE TYPE public.app_permission AS ENUM (
    'app.read',
    'app.insert',
    'app.update',
    'app.delete',
    'profile.read',
    'profile.insert',
    'profile.update',
    'profile.delete',
    'api_key.read',
    'api_key.insert',
    'api_key.update',
    'api_key.delete',
    'tenant.read',
    'tenant.update',
    'billing.read',
    'billing.update',
    'billing.insert',
    'git_connection.read',
    'git_connection.insert',
    'git_connection.update',
    'git_connection.delete',
    'git_branch.read',
    'git_branch.insert',
    'git_branch.update',
    'git_branch.delete',
    'dashboard.read',
    'dashboard.insert',
    'dashboard.update',
    'dashboard.delete',
    'app_member_role.read',
    'app_member_role.insert',
    'app_member_role.update',
    'app_member_role.delete',
    'sso_config.read',
    'sso_config.insert',
    'sso_config.update',
    'sso_config.delete',
    'custom_role.read',
    'custom_role.insert',
    'custom_role.update',
    'custom_role.delete',
    'trace.read',
    'experiment.read',
    'env_var.read',
    'env_var.insert',
    'env_var.update',
    'env_var.delete',
    -- Gateway permission names. These mirror `GatewayPermission` in
    -- `packages/gateway-core/src/lib/permissions.ts` so that `app_authorize()`
    -- can evaluate the same permission string whether it's being checked
    -- from the dashboard (user session) or the gateway (bearer path).
    -- Without these, the bearer path's `app_authorize` RPC would error
    -- on the enum cast and silently 403 every mutation. Added so the
    -- human-via-CLI and human-via-dashboard paths apply the same policy.
    'trace.write',
    'score.read',
    'score.write',
    'score.delete',
    'span.read',
    'session.read',
    'metrics.read',
    -- Environments & promotion. `environment.promote` covers both forward
    -- promote and rollback: they carry the same blast radius, so splitting
    -- them would imply a safety difference that does not exist. All grants
    -- are app-level; per-env scoping is not modelled.
    'environment.read',
    'environment.insert',
    'environment.update',
    'environment.delete',
    'environment.promote',
    -- Governs app-level publish policy fields (e.g. `app.require_pull_request`).
    -- Deliberately separate from `app.update`: editing the app must not let a
    -- caller weaken the review gate. RLS is row-level and cannot single out one
    -- column, so this permission is enforced by the `enforce_app_policy_permission`
    -- guard trigger on the policy column rather than by an `app` UPDATE policy.
    -- Appended at the end to match the established ADD VALUE migration pattern.
    'app_policy.update',
    -- Tenant-facing read of the org's own audit trail (public.audit_log rows
    -- where tenant_id = the caller's tenant). Read-only:
    -- the trail is written exclusively by service_role (single write seam +
    -- SECURITY DEFINER transaction functions), so no insert/update/delete
    -- permissions exist. Seeded to owner + admin in 12-rbac.sql.
    'audit_log.read',
    -- Context layer: mirror reads gate on context.read; saves through the
    -- context-core save path require .insert (create) / .update / .delete as
    -- appropriate. Never "manage", per the granular pattern. Appended at the
    -- end to match the established ADD VALUE migration pattern.
    'context.read',
    'context.insert',
    'context.update',
    'context.delete',
    -- Agent sessions — actor privacy. Session transcripts are
    -- self-by-default; team-wide read is an explicit, admin-granted permission
    -- (market norm: no vendor exposes peers' session transcripts, and even
    -- per-user metrics are admin-gated). `self.read` = a member's own sessions only; `team.read` =
    -- every actor's sessions in the app. Settings governs capture-tier/agents
    -- config.
    'agents.sessions.self.read',
    'agents.sessions.team.read',
    'agents.settings.write',
    -- Cloud workers: terminal coding-agent runs on managed
    -- machines. read = see runs + transcripts, insert = launch, update =
    -- cancel, delete = remove from history. Granular per the established
    -- pattern; never "manage".
    'worker_run.read',
    'worker_run.insert',
    'worker_run.update',
    'worker_run.delete',
    -- Org-wide AI program cost configuration (seat spend feeding "Total Cost
    -- of AI"). Tenant-scoped, admin-maintained; the dashboard widget reads
    -- the derived total via service role, so these gate only the settings
    -- surface. Granular per the established pattern; never "manage".
    'ai_cost_config.read',
    'ai_cost_config.insert',
    'ai_cost_config.update',
    'ai_cost_config.delete',
    -- Member lifecycle, distinct from `profile.*`. The profile permissions are
    -- self-service — every role holds profile.insert/update so a member can
    -- create and edit their OWN profile — so they must never gate a privileged
    -- operation. Inviting, changing a role, disabling and removing get their
    -- own vocabulary, which keeps the self-service grant broad without letting
    -- it confer member management.
    --
    -- Appended rather than grouped next to `profile.*`: `ALTER TYPE ADD VALUE`
    -- can only append, so declaring them mid-list makes `db diff` want to
    -- rebuild the whole type (dropping and recreating every policy that
    -- references it) on every run.
    'membership.read',
    'membership.insert',
    'membership.update',
    'membership.delete'
);

-- -----------------------------------------------------------------------------
-- Platform Admin Role System (Orthogonal to Tenant Roles)
-- -----------------------------------------------------------------------------

-- Platform-level roles for system administration
CREATE TYPE public.platform_role AS ENUM (
    'platform_admin'
);

-- Platform-level permissions for administrative actions
CREATE TYPE public.platform_permission AS ENUM (
    'platform.org.read',
    'platform.org.delete',
    'platform.user.read',
    'platform.user.delete',
    'platform.temp_access.grant',
    'platform.flag.manage',
    'platform.audit.read',
    -- Dead values: changelog table dropped with the platform-admin notifications
    -- removal (kept for DB compat). Do not grant them to a role.
    'platform.changelog.read',
    'platform.changelog.write',
    'platform.changelog.delete',
    'platform.entitlement.read',
    'platform.entitlement.write',
    'platform.entitlement.delete',
    -- Dead value: the DORA-metrics tables are gone (delivery tracking lives
    -- outside this app); label retained for the same reason as the
    -- alert_agent labels below. Do not grant it to a role.
    'platform.dora.read',
    -- No table or policy references the six alert_agent labels below. Postgres
    -- has no DROP VALUE for enums, and rebuilding platform_permission would mean
    -- dropping and recreating private.platform_authorize plus every RLS policy
    -- that casts to this type, so they stay. Do not grant them to a role.
    'platform.alert_agent_config.read',
    'platform.alert_agent_config.write',
    'platform.alert_agent_config.update',
    'platform.alert_agent_config.delete',
    'platform.alert_agent_run.read',
    'platform.alert_agent_run.write',
    'platform.sso_config.read',
    -- Cross-tenant env state read (env rows + deployment saga rows — but NOT
    -- content snapshots) + intervention verb for recovery operations
    -- (force-mark stuck sagas as failed, manual snapshot GC, force-redeploy a
    -- wedged Fly machine). All interventions write to the audit log with a
    -- required `reason` parameter.
    'platform.environment.read',
    'platform.promotion.intervene'
);

-- -----------------------------------------------------------------------------
-- Feature Flag System
-- -----------------------------------------------------------------------------

CREATE TYPE public.flag_strategy AS ENUM (
    'global',
    'random',
    'targeted',
    'percentage'
);

-- -----------------------------------------------------------------------------
-- Promotion / Deployment Saga State Machine
-- -----------------------------------------------------------------------------

-- The promote/rollback saga lives on the deployment table:
-- deployment.deployment_status is a TEXT column constrained by CHECK (see
-- 26-deployment.sql) covering pending / snapshotting / deploying / success /
-- failed. No enum type is defined here; the constraint lives with the table.

