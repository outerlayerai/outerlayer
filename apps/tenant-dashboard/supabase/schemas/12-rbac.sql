-- =============================================================================
-- RBAC (Role-Based Access Control) Schema
-- =============================================================================
-- Purpose: Role and permission management for tenant and platform access
-- Dependencies: 01-types.sql, 10-tenant.sql, 11-profile.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Membership Table (User-Tenant Relationship with Role)
-- -----------------------------------------------------------------------------

-- Users can belong to multiple organizations with per-org roles.
-- Membership carries the role and the invitation lifecycle together.
CREATE TABLE IF NOT EXISTS public.membership (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    role public.app_role NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',

    -- Invitation tracking
    invited_at TIMESTAMPTZ,
    invited_by UUID REFERENCES auth.users(id),
    expires_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,

    -- App-level scoping (explicit flag — decoupled from app_member_role row existence)
    is_app_scoped BOOLEAN NOT NULL DEFAULT false,

    -- Audit columns
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,

    -- Constraints
    CONSTRAINT membership_user_tenant_unique UNIQUE (user_id, tenant_id),
    CONSTRAINT membership_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'active'::character varying])::text[])))
);

COMMENT ON TABLE public.membership IS 'User-tenant relationships with role and invitation tracking for multi-tenant membership';
COMMENT ON COLUMN public.membership.role IS 'User role within the tenant (owner/admin/write/read/disabled)';
COMMENT ON COLUMN public.membership.status IS 'pending = invited but not accepted, active = full member';
COMMENT ON COLUMN public.membership.expires_at IS '7-day expiry for pending invitations';
COMMENT ON COLUMN public.membership.accepted_at IS 'Timestamp when user accepted the invitation';

-- -----------------------------------------------------------------------------
-- Membership Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_membership_tenant_id ON public.membership(tenant_id);
CREATE INDEX IF NOT EXISTS idx_membership_status ON public.membership(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_membership_user_status ON public.membership(user_id, status);
CREATE INDEX IF NOT EXISTS idx_membership_tenant_role ON public.membership(tenant_id, role) WHERE status = 'active';

-- Backs the invited_by foreign key. Postgres indexes the referenced side of an
-- FK automatically but never the referencing side, so without this every
-- profile delete sequentially scans membership to run the RI check.
CREATE INDEX IF NOT EXISTS idx_membership_invited_by ON public.membership(invited_by);

-- -----------------------------------------------------------------------------
-- Role Permissions Table
-- -----------------------------------------------------------------------------

-- Maps roles to permissions (what each role is allowed to do)
CREATE TABLE IF NOT EXISTS public.role_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid() UNIQUE,
    role public.app_role NOT NULL,
    permission public.app_permission NOT NULL,
    UNIQUE (role, permission)
);

COMMENT ON TABLE public.role_permissions IS 'Application permissions for each role.';

-- Role Permissions RLS
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow auth admin to read user roles" ON "public"."role_permissions" FOR SELECT TO "supabase_auth_admin" USING (true);

-- Authenticated users can read role→permission mappings (needed for client-side
-- effective-permission resolution in useAppPermissions)
CREATE POLICY "Allow authenticated to read role_permissions" ON "public"."role_permissions" FOR SELECT TO "authenticated" USING (true);

-- Grant SELECT so authenticated role can read the mapping table
GRANT SELECT ON public.role_permissions TO authenticated;

-- -----------------------------------------------------------------------------
-- Platform User Role Table
-- -----------------------------------------------------------------------------

-- Platform-level roles (separate from tenant roles)
-- Users can have BOTH a platform role AND tenant roles simultaneously
CREATE TABLE IF NOT EXISTS public.platform_user_role (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.profile(id) ON DELETE CASCADE NOT NULL,
    role public.platform_role NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    UNIQUE(user_id)  -- One platform role per user max
);

COMMENT ON TABLE public.platform_user_role IS 'Platform-level roles for system administration (separate from tenant roles)';

-- -----------------------------------------------------------------------------
-- Platform Role Permissions Table
-- -----------------------------------------------------------------------------

-- Maps platform roles to platform permissions
CREATE TABLE IF NOT EXISTS public.platform_role_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role public.platform_role NOT NULL,
    permission public.platform_permission NOT NULL,
    UNIQUE(role, permission)
);

COMMENT ON TABLE public.platform_role_permissions IS 'Platform permissions for each platform role';

-- -----------------------------------------------------------------------------
-- Membership RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.membership ENABLE ROW LEVEL SECURITY;

-- No authenticated INSERT policy on membership, by design. With RLS enabled and
-- no INSERT policy, every direct authenticated insert is denied — so a member
-- cannot POST a membership row granting owner (or any role) to themselves or an
-- accomplice. An INSERT policy gated on profile.insert would not be equivalent:
-- every role down to read holds that permission, and a row-level policy cannot
-- constrain the role/user_id/status columns. Every legitimate membership row
-- is created by a SECURITY DEFINER RPC (create_organization_transaction,
-- invite_new_user_transaction, invite_existing_user_transaction,
-- grant_temp_access_transaction) that bypasses RLS; the app gates invites at the
-- action layer. Do not add a member-satisfiable INSERT policy here.

-- Member lifecycle is gated on membership.*, not the self-service profile.*
-- permissions every role holds. See 01-types.sql for why they are separate.
CREATE POLICY "Admins can remove users" ON "public"."membership" FOR DELETE USING ((("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND ( SELECT "private"."authorize"('membership.delete'::"public"."app_permission"))));

-- Acceptance only, and only of a LIVE invite. The service layer's expiry check
-- is in TypeScript, but RLS is the boundary a direct PostgREST call has to
-- satisfy, so status and expiry are predicates here too. USING pins the
-- pre-image to a pending, unexpired row; WITH CHECK pins the post-image to
-- active, so this policy can only ever perform an acceptance. Nothing purges
-- lapsed invites, so the expiry term is what bounds an invitation's life.
CREATE POLICY "Users can accept invitations" ON "public"."membership" FOR UPDATE USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("status")::"text" = 'pending'::"text") AND (("expires_at" IS NULL) OR ("expires_at" > "now"())))) WITH CHECK ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("status")::"text" = 'active'::"text")));

CREATE POLICY "Users can read memberships" ON "public"."membership" FOR SELECT USING ((("user_id" = ( SELECT "auth"."uid"() AS "uid")) OR (("tenant_id" = ( SELECT "public"."tenant_id"() AS "tenant_id")) AND ( SELECT "private"."authorize"('membership.read'::"public"."app_permission")))));

-- Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.membership TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.membership TO service_role;

-- -----------------------------------------------------------------------------
-- Membership-Dependent Policies (must be after membership table creation)
-- -----------------------------------------------------------------------------

-- Combined tenant read policy: users can read their active tenant OR any tenant they're a member of
CREATE POLICY "Users can read tenant" ON "public"."tenant" FOR SELECT USING (((( SELECT "private"."authorize"('tenant.read'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")) OR ("tenant_id" IN ( SELECT "m"."tenant_id"
   FROM "public"."membership" "m"
  WHERE (("m"."user_id" = ( SELECT "auth"."uid"() AS "uid")) AND (("m"."status")::"text" = 'active'::"text"))))));

-- Tenant admin update policy
CREATE POLICY "Enable tenant admin to update tenant" ON "public"."tenant" FOR UPDATE USING ((( SELECT "private"."authorize"('tenant.update'::"public"."app_permission")) AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

-- Users can read their own profile or profiles of active members in their
-- tenant. No permission check — profile data (name, email, avatar) is not
-- sensitive and is needed across the app (deployments, member lists, etc.).
-- Cross-tenant isolation is enforced via tenant_id() on membership.
CREATE POLICY "Users can read profiles"
    ON public.profile
    FOR SELECT
    USING (
      (id = ( SELECT auth.uid() AS uid))
      OR
      (id IN (
        SELECT m.user_id
        FROM public.membership m
        WHERE m.tenant_id = ( SELECT public.tenant_id() AS tenant_id)
          AND (m.status)::text = 'active'::text
      ))
    );

-- Users can update their own profile (no permission check — any authenticated user can edit their own profile)
CREATE POLICY "Users can update own profile"
    ON public.profile
    FOR UPDATE
    USING ((id = ( SELECT auth.uid() AS uid)))
    WITH CHECK ((id = ( SELECT auth.uid() AS uid)));

-- -----------------------------------------------------------------------------
-- Platform Tables RLS (Service Role Only)
-- -----------------------------------------------------------------------------

ALTER TABLE public.platform_user_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_role_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON "public"."platform_user_role" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

CREATE POLICY "service_role_all" ON "public"."platform_role_permissions" USING ((( SELECT "auth"."role"() AS "role") = 'service_role'::"text"));

-- Grant access to auth admin for custom_access_token_hook
grant delete on table "public"."membership" to "supabase_auth_admin";
grant insert on table "public"."membership" to "supabase_auth_admin";
grant references on table "public"."membership" to "supabase_auth_admin";
grant select on table "public"."membership" to "supabase_auth_admin";
grant trigger on table "public"."membership" to "supabase_auth_admin";
grant truncate on table "public"."membership" to "supabase_auth_admin";
grant update on table "public"."membership" to "supabase_auth_admin";
grant delete on table "public"."platform_user_role" to "supabase_auth_admin";
grant insert on table "public"."platform_user_role" to "supabase_auth_admin";
grant references on table "public"."platform_user_role" to "supabase_auth_admin";
grant select on table "public"."platform_user_role" to "supabase_auth_admin";
grant trigger on table "public"."platform_user_role" to "supabase_auth_admin";
grant truncate on table "public"."platform_user_role" to "supabase_auth_admin";
grant update on table "public"."platform_user_role" to "supabase_auth_admin";

-- Note: Membership trigger functions (check_membership_limit, protect_last_owner,
-- prevent_membership_tenant_change) are defined in 03-functions-transactions.sql
-- Triggers are defined in 99-triggers.sql

-- -----------------------------------------------------------------------------
-- Built-in Role Permissions Seed (generated)
-- -----------------------------------------------------------------------------
-- Single source: packages/db-types/permission-seed.json. The block between the
-- BEGIN/END markers is emitted by `yarn codegen:permissions`; do not hand-edit
-- it. Custom-role permissions are runtime DB rows and are not seeded here.
-- BEGIN GENERATED role_permissions — source: packages/db-types/permission-seed.json
-- Every row below is generated from permission-seed.json. This block is the
-- reviewable declarative mirror of the seed; the rows are applied to the
-- database by the role_permissions seed migrations. Edit the JSON and run
-- `yarn codegen:permissions` — never hand-edit between the markers.

-- Agent sessions are self-by-default: every active role reads its own
-- sessions. Team-wide session read (other members' sessions and
-- transcripts) and agents/capture-tier settings are admin-granted, so they
-- go to owner/admin only.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'agents.sessions.self.read'),
    ('admin', 'agents.sessions.self.read'),
    ('write', 'agents.sessions.self.read'),
    ('read', 'agents.sessions.self.read'),
    ('owner', 'agents.sessions.team.read'),
    ('admin', 'agents.sessions.team.read'),
    ('owner', 'agents.settings.write'),
    ('admin', 'agents.settings.write')
ON CONFLICT (role, permission) DO NOTHING;

-- Org-wide seat-cost configuration (Settings -> AI costs): owner/admin
-- only, like billing — it is org-level financial config. The dashboard
-- widget that consumes the derived total reads via service_role, so members
-- still see Total Cost of AI without these grants.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'ai_cost_config.delete'),
    ('admin', 'ai_cost_config.delete'),
    ('owner', 'ai_cost_config.insert'),
    ('admin', 'ai_cost_config.insert'),
    ('owner', 'ai_cost_config.read'),
    ('admin', 'ai_cost_config.read'),
    ('owner', 'ai_cost_config.update'),
    ('admin', 'ai_cost_config.update')
ON CONFLICT (role, permission) DO NOTHING;

-- API keys: owner/admin/write view and create keys; rotating (update) and
-- revoking (delete) a key is owner/admin only.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'api_key.delete'),
    ('admin', 'api_key.delete'),
    ('owner', 'api_key.insert'),
    ('admin', 'api_key.insert'),
    ('write', 'api_key.insert'),
    ('owner', 'api_key.read'),
    ('admin', 'api_key.read'),
    ('write', 'api_key.read'),
    ('owner', 'api_key.update'),
    ('admin', 'api_key.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Apps: every role reads; creating, editing, and deleting an app is
-- owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'app.delete'),
    ('admin', 'app.delete'),
    ('owner', 'app.insert'),
    ('admin', 'app.insert'),
    ('owner', 'app.read'),
    ('admin', 'app.read'),
    ('write', 'app.read'),
    ('read', 'app.read'),
    ('owner', 'app.update'),
    ('admin', 'app.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Per-app role overrides: every role can see who holds which app role;
-- assigning and revoking overrides is owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'app_member_role.delete'),
    ('admin', 'app_member_role.delete'),
    ('owner', 'app_member_role.insert'),
    ('admin', 'app_member_role.insert'),
    ('owner', 'app_member_role.read'),
    ('admin', 'app_member_role.read'),
    ('write', 'app_member_role.read'),
    ('read', 'app_member_role.read'),
    ('owner', 'app_member_role.update'),
    ('admin', 'app_member_role.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Governs the app-level publish policy (require_pull_request). Owner/admin
-- only: it is a governance control, and a member who can publish must not
-- be able to remove the review gate. Owner is seeded explicitly because the
-- owner bypass in private.effective_app_permissions (01a-private-authz.sql)
-- returns the owner's org role_permissions set — an owner not seeded this
-- permission would be denied here.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'app_policy.update'),
    ('admin', 'app_policy.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Tenant audit-trail read. Owner/admin only: the trail carries member
-- emails, IPs, and denied-attempt records. The trail is written exclusively
-- by service_role, so there is no insert/update/delete.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'audit_log.read'),
    ('admin', 'audit_log.read')
ON CONFLICT (role, permission) DO NOTHING;

-- Billing: every role sees the plan and usage; changing the subscription
-- (insert/update/delete) is owner only.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'billing.insert'),
    ('owner', 'billing.read'),
    ('admin', 'billing.read'),
    ('write', 'billing.read'),
    ('read', 'billing.read'),
    ('owner', 'billing.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Context mirror: every role reads the mirror; write roles save, update,
-- and delete context files.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'context.delete'),
    ('admin', 'context.delete'),
    ('write', 'context.delete'),
    ('owner', 'context.insert'),
    ('admin', 'context.insert'),
    ('write', 'context.insert'),
    ('owner', 'context.read'),
    ('admin', 'context.read'),
    ('write', 'context.read'),
    ('read', 'context.read'),
    ('owner', 'context.update'),
    ('admin', 'context.update'),
    ('write', 'context.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Custom roles: owner/admin define, edit, and delete custom roles.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'custom_role.delete'),
    ('admin', 'custom_role.delete'),
    ('owner', 'custom_role.insert'),
    ('admin', 'custom_role.insert'),
    ('owner', 'custom_role.read'),
    ('admin', 'custom_role.read'),
    ('owner', 'custom_role.update'),
    ('admin', 'custom_role.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Analytics dashboards: every role views; write roles create, edit, and
-- delete dashboards.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'dashboard.delete'),
    ('admin', 'dashboard.delete'),
    ('write', 'dashboard.delete'),
    ('owner', 'dashboard.insert'),
    ('admin', 'dashboard.insert'),
    ('write', 'dashboard.insert'),
    ('owner', 'dashboard.read'),
    ('admin', 'dashboard.read'),
    ('write', 'dashboard.read'),
    ('read', 'dashboard.read'),
    ('owner', 'dashboard.update'),
    ('admin', 'dashboard.update'),
    ('write', 'dashboard.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Environment variables: every role reads; write roles set, update, and
-- remove them.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'env_var.delete'),
    ('admin', 'env_var.delete'),
    ('write', 'env_var.delete'),
    ('owner', 'env_var.insert'),
    ('admin', 'env_var.insert'),
    ('write', 'env_var.insert'),
    ('owner', 'env_var.read'),
    ('admin', 'env_var.read'),
    ('write', 'env_var.read'),
    ('read', 'env_var.read'),
    ('owner', 'env_var.update'),
    ('admin', 'env_var.update'),
    ('write', 'env_var.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Environment lifecycle: every role reads; write roles create and edit;
-- deleting an environment is owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'environment.delete'),
    ('admin', 'environment.delete'),
    ('owner', 'environment.insert'),
    ('admin', 'environment.insert'),
    ('write', 'environment.insert'),
    ('owner', 'environment.read'),
    ('admin', 'environment.read'),
    ('write', 'environment.read'),
    ('read', 'environment.read'),
    ('owner', 'environment.update'),
    ('admin', 'environment.update'),
    ('write', 'environment.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Tracked git branches: every role reads; owner/admin manage.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'git_branch.delete'),
    ('admin', 'git_branch.delete'),
    ('owner', 'git_branch.insert'),
    ('admin', 'git_branch.insert'),
    ('owner', 'git_branch.read'),
    ('admin', 'git_branch.read'),
    ('write', 'git_branch.read'),
    ('read', 'git_branch.read'),
    ('owner', 'git_branch.update'),
    ('admin', 'git_branch.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Git provider connection: every role reads; write roles connect and
-- reconfigure; disconnecting is owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'git_connection.delete'),
    ('admin', 'git_connection.delete'),
    ('owner', 'git_connection.insert'),
    ('admin', 'git_connection.insert'),
    ('write', 'git_connection.insert'),
    ('owner', 'git_connection.read'),
    ('admin', 'git_connection.read'),
    ('write', 'git_connection.read'),
    ('read', 'git_connection.read'),
    ('owner', 'git_connection.update'),
    ('admin', 'git_connection.update'),
    ('write', 'git_connection.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Member lifecycle, kept separate from profile.* on purpose.
-- profile.insert/update are self-service and held by every role so a member
-- can create and edit their own profile; inviting a member, changing a
-- role, disabling and removing are privileged and belong to owner/admin
-- only. Never gate a lifecycle operation on a self-service permission.
-- membership.read stays broad because the member list is already visible to
-- every role.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'membership.delete'),
    ('admin', 'membership.delete'),
    ('owner', 'membership.insert'),
    ('admin', 'membership.insert'),
    ('owner', 'membership.read'),
    ('admin', 'membership.read'),
    ('write', 'membership.read'),
    ('read', 'membership.read'),
    ('owner', 'membership.update'),
    ('admin', 'membership.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Gateway-facing metrics read (SDK/CLI surface).
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'metrics.read'),
    ('admin', 'metrics.read'),
    ('write', 'metrics.read'),
    ('read', 'metrics.read')
ON CONFLICT (role, permission) DO NOTHING;

-- Member profiles: every active member reads teammates and creates/edits
-- their own profile; removing a member (delete) is owner/admin.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'profile.delete'),
    ('admin', 'profile.delete'),
    ('owner', 'profile.insert'),
    ('admin', 'profile.insert'),
    ('write', 'profile.insert'),
    ('read', 'profile.insert'),
    ('owner', 'profile.read'),
    ('admin', 'profile.read'),
    ('write', 'profile.read'),
    ('read', 'profile.read'),
    ('owner', 'profile.update'),
    ('admin', 'profile.update'),
    ('write', 'profile.update'),
    ('read', 'profile.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Gateway-facing scores: every role reads; write roles write; owner/admin
-- delete.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'score.delete'),
    ('admin', 'score.delete'),
    ('owner', 'score.read'),
    ('admin', 'score.read'),
    ('write', 'score.read'),
    ('read', 'score.read'),
    ('owner', 'score.write'),
    ('admin', 'score.write'),
    ('write', 'score.write')
ON CONFLICT (role, permission) DO NOTHING;

-- Gateway-facing session read (SDK/CLI surface).
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'session.read'),
    ('admin', 'session.read'),
    ('write', 'session.read'),
    ('read', 'session.read')
ON CONFLICT (role, permission) DO NOTHING;

-- Gateway-facing span read (SDK/CLI surface).
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'span.read'),
    ('admin', 'span.read'),
    ('write', 'span.read'),
    ('read', 'span.read')
ON CONFLICT (role, permission) DO NOTHING;

-- Enterprise SSO config: owner/admin view and edit; only the owner deletes
-- the SSO connection.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'sso_config.delete'),
    ('owner', 'sso_config.insert'),
    ('admin', 'sso_config.insert'),
    ('owner', 'sso_config.read'),
    ('admin', 'sso_config.read'),
    ('owner', 'sso_config.update'),
    ('admin', 'sso_config.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Organization record: every role reads; write roles edit organization
-- settings. tenant.delete and tenant.insert are deliberately ungranted — no
-- RLS policy references them, so they conferred nothing. Orgs are created
-- by create_organization_transaction and deleted only by platform admins,
-- both SECURITY DEFINER paths that bypass RLS.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'tenant.read'),
    ('admin', 'tenant.read'),
    ('write', 'tenant.read'),
    ('read', 'tenant.read'),
    ('owner', 'tenant.update'),
    ('admin', 'tenant.update'),
    ('write', 'tenant.update')
ON CONFLICT (role, permission) DO NOTHING;

-- Traces: every role reads; write roles ingest spans (SDK/CLI).
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'trace.read'),
    ('admin', 'trace.read'),
    ('write', 'trace.read'),
    ('read', 'trace.read'),
    ('owner', 'trace.write'),
    ('admin', 'trace.write'),
    ('write', 'trace.write')
ON CONFLICT (role, permission) DO NOTHING;

-- Cloud workers: every role reads run history and transcripts; write roles
-- launch, cancel, and delete runs.
INSERT INTO public.role_permissions (role, permission) VALUES
    ('owner', 'worker_run.delete'),
    ('admin', 'worker_run.delete'),
    ('write', 'worker_run.delete'),
    ('owner', 'worker_run.insert'),
    ('admin', 'worker_run.insert'),
    ('write', 'worker_run.insert'),
    ('owner', 'worker_run.read'),
    ('admin', 'worker_run.read'),
    ('write', 'worker_run.read'),
    ('read', 'worker_run.read'),
    ('owner', 'worker_run.update'),
    ('admin', 'worker_run.update'),
    ('write', 'worker_run.update')
ON CONFLICT (role, permission) DO NOTHING;
-- END GENERATED role_permissions

-- -----------------------------------------------------------------------------
-- Data API role grants (explicit)
-- -----------------------------------------------------------------------------
-- Supabase no longer auto-grants anon/authenticated/service_role on public
-- tables for databases created after 2026-05-30 (changelog #45329). These
-- tables previously relied on that auto-default. Declare the grants
-- explicitly so fresh installs match existing projects; RLS above still gates
-- every row.
-- -----------------------------------------------------------------------------

GRANT ALL ON public.platform_role_permissions TO anon;
GRANT ALL ON public.platform_role_permissions TO authenticated;
GRANT ALL ON public.platform_role_permissions TO service_role;

GRANT ALL ON public.platform_user_role TO anon;
GRANT ALL ON public.platform_user_role TO authenticated;
GRANT ALL ON public.platform_user_role TO service_role;
