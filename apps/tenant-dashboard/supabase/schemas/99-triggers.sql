-- =============================================================================
-- Triggers Schema
-- =============================================================================
-- Purpose: All database triggers for the application
-- Dependencies: All other schema files (tables, functions)
-- Note: Centralized trigger definitions for maintainability
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Membership Triggers
-- -----------------------------------------------------------------------------

-- Bounds one user to 10 active memberships across all tenants. Despite sitting
-- on membership, this is not a per-tenant seat limit and reads no billing tier
-- — see check_membership_limit() in 03-functions-transactions.sql.
CREATE OR REPLACE TRIGGER enforce_membership_limit
    BEFORE INSERT OR UPDATE ON public.membership
    FOR EACH ROW EXECUTE FUNCTION public.check_membership_limit();

CREATE OR REPLACE TRIGGER prevent_membership_tenant_change_trigger
    BEFORE UPDATE ON public.membership
    FOR EACH ROW EXECUTE FUNCTION public.prevent_membership_tenant_change();

CREATE OR REPLACE TRIGGER protect_last_owner_trigger
    BEFORE DELETE OR UPDATE ON public.membership
    FOR EACH ROW EXECUTE FUNCTION public.protect_last_owner();

-- Column guard for the self-service "Users can accept invitations" UPDATE
-- policy: a member may accept their own invite (status/accepted_at) but must
-- not self-edit privilege-bearing columns (role → owner, custom_role_id,
-- is_app_scoped, invited_by, ...). Only enforced for direct 'authenticated'
-- PostgREST callers — see prevent_membership_self_privilege_change() in
-- 03-functions-transactions.sql.
-- Blocks an admin granting themselves a per-app role (see
-- prevent_app_member_role_self_grant() in 03-functions-transactions.sql).
CREATE OR REPLACE TRIGGER prevent_app_member_role_self_grant
    BEFORE INSERT OR UPDATE ON public.app_member_role
    FOR EACH ROW EXECUTE FUNCTION public.prevent_app_member_role_self_grant();

CREATE OR REPLACE TRIGGER prevent_membership_self_privilege_change_trigger
    BEFORE UPDATE ON public.membership
    FOR EACH ROW EXECUTE FUNCTION public.prevent_membership_self_privilege_change();

-- -----------------------------------------------------------------------------
-- User Role Triggers
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- Tenant ID Auto-Set Triggers (INSERT)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE TRIGGER on_create_set_app_tenant_id_column
    BEFORE INSERT ON public.app
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();

-- Seed the mandatory default `dev` environment for every new app.
-- AFTER INSERT so NEW.id and the tenant_id set by
-- on_create_set_app_tenant_id_column above are both final. The function lives
-- in 52-environment.sql (it writes the `environment` table); declared here with
-- the other `ON public.app` triggers. Makes "every app has exactly one default
-- env" hold for ALL create paths — see app_seed_default_env()'s comment.
CREATE OR REPLACE TRIGGER on_create_seed_default_env
    AFTER INSERT ON public.app
    FOR EACH ROW EXECUTE FUNCTION public.app_seed_default_env();

CREATE OR REPLACE TRIGGER on_insert_api_key
    BEFORE INSERT ON public.api_key
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();

CREATE OR REPLACE TRIGGER on_insert_git_branch_set_tenant_id
    BEFORE INSERT ON public.git_branch
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();

CREATE OR REPLACE TRIGGER on_insert_git_connection_set_tenant_id
    BEFORE INSERT ON public.git_connection
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();

CREATE OR REPLACE TRIGGER on_insert_git_identity_set_tenant_id
    BEFORE INSERT ON public.user_git_identity
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();

CREATE OR REPLACE TRIGGER on_insert_notification_set_tenant_id
    BEFORE INSERT ON public.notification
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();

CREATE OR REPLACE TRIGGER on_insert_saved_trace_filters_set_tenant_id
    BEFORE INSERT ON public.saved_trace_filters
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();

CREATE OR REPLACE TRIGGER on_insert_app_member_role_set_tenant_id
    BEFORE INSERT ON public.app_member_role
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();

CREATE OR REPLACE TRIGGER on_insert_custom_role_set_tenant_id
    BEFORE INSERT ON public.custom_role
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();


-- -----------------------------------------------------------------------------
-- Created Columns Triggers (INSERT)
-- -----------------------------------------------------------------------------
-- The INSERT counterpart to the Updated Columns Triggers below. set_created_columns()
-- stamps created_by for human writes and leaves it as the handler set it (NULL
-- when unset) for gateway/service_role writes — replacing the per-table
-- `created_by UUID DEFAULT auth.uid()` defaults (dropped in their schemas).

CREATE OR REPLACE TRIGGER on_insert_api_key_set_created_columns
    BEFORE INSERT ON public.api_key
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_app_set_created_columns
    BEFORE INSERT ON public.app
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_app_member_role_set_created_columns
    BEFORE INSERT ON public.app_member_role
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_custom_role_set_created_columns
    BEFORE INSERT ON public.custom_role
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_git_branch_set_created_columns
    BEFORE INSERT ON public.git_branch
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_git_connection_set_created_columns
    BEFORE INSERT ON public.git_connection
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_saved_trace_filters_set_created_columns
    BEFORE INSERT ON public.saved_trace_filters
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();


-- -----------------------------------------------------------------------------
-- Updated Columns Triggers (UPDATE)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE TRIGGER on_update_git_branch_set_updated_columns
    BEFORE UPDATE ON public.git_branch
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_git_connection_set_updated_columns
    BEFORE UPDATE ON public.git_connection
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

-- user_git_identity has updated_at but no updated_by, so it takes the
-- updated_at-only trigger. set_updated_columns() assigns NEW.updated_by and
-- raises `record "new" has no field "updated_by"` here — only on the
-- authenticated branch, which is exactly the path the "Enable update for own
-- identity" policy exists to allow.
CREATE OR REPLACE TRIGGER on_update_git_identity_set_updated_at
    BEFORE UPDATE ON public.user_git_identity
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_only();

CREATE OR REPLACE TRIGGER on_update_notification_set_updated_columns
    BEFORE UPDATE ON public.notification
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_api_key_updated_columns
    BEFORE UPDATE ON public.api_key
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_app_updated_columns
    BEFORE UPDATE ON public.app
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_pull_request_updated_columns
    BEFORE UPDATE ON public.pull_request
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_ai_cost_config_updated_columns
    BEFORE UPDATE ON public.ai_cost_config
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

-- Guards app-level publish policy columns (require_pull_request) behind the
-- dedicated app_policy.update permission. See enforce_app_policy_permission()
-- in 03-functions-transactions.sql.
CREATE OR REPLACE TRIGGER enforce_app_policy_permission_trigger
    BEFORE UPDATE ON public.app
    FOR EACH ROW EXECUTE FUNCTION public.enforce_app_policy_permission();

CREATE OR REPLACE TRIGGER on_update_set_billing_updated_columns
    BEFORE UPDATE ON public.billing
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_updated_columns
    BEFORE UPDATE ON public.tenant
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_saved_trace_filters_set_updated_columns
    BEFORE UPDATE ON public.saved_trace_filters
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_updated_columns
    BEFORE UPDATE ON public.temp_access_grant
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_terms_agreement_set_updated_columns
    BEFORE UPDATE ON public.terms_agreement
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

-- Environments & promotion
CREATE OR REPLACE TRIGGER on_update_environment_set_updated_columns
    BEFORE UPDATE ON public.environment
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_updated_columns
    BEFORE UPDATE ON public.feature_flag
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_updated_columns
    BEFORE UPDATE ON public.feature_flag_override
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_updated_columns
    BEFORE UPDATE ON public.membership
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_updated_columns
    BEFORE UPDATE ON public.platform_user_role
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_dashboard_set_updated_columns
    BEFORE UPDATE ON public.dashboard
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_dashboard_widget_set_updated_columns
    BEFORE UPDATE ON public.dashboard_widget
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_app_member_role_set_updated_columns
    BEFORE UPDATE ON public.app_member_role
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_custom_role_set_updated_columns
    BEFORE UPDATE ON public.custom_role
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_insert_env_var_set_tenant_id
    BEFORE INSERT ON public.env_var
    FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();

CREATE OR REPLACE TRIGGER on_update_env_var_set_updated_columns
    BEFORE UPDATE ON public.env_var
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

CREATE OR REPLACE TRIGGER on_update_set_updated_at
    BEFORE UPDATE ON public.profile
    FOR EACH ROW EXECUTE FUNCTION public.set_profile_updated_at();

-- -----------------------------------------------------------------------------
-- Auth User Email Sync Trigger
-- -----------------------------------------------------------------------------

-- Sync email changes from auth.users to public.profile automatically
CREATE TRIGGER on_auth_user_updated_sync_email
    AFTER UPDATE ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.sync_auth_email_to_profile();

-- -----------------------------------------------------------------------------
-- Entitlement Override Audit Trigger
-- -----------------------------------------------------------------------------

CREATE TRIGGER on_update_set_tenant_entitlement_override_updated_columns
    BEFORE UPDATE ON public.tenant_entitlement_override
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_columns();

-- -----------------------------------------------------------------------------
-- Downgrade Protection: Custom Role Nullification on Tier Change
-- -----------------------------------------------------------------------------

-- Fires after billing tier_id is updated. If the new tier disables custom_roles,
-- NULLs out custom_role_id on all memberships for that tenant.
-- Function defined in 02-functions-core.sql.
CREATE OR REPLACE TRIGGER on_billing_tier_change_nullify_custom_roles
    AFTER UPDATE OF tier_id ON public.billing
    FOR EACH ROW EXECUTE FUNCTION public.nullify_custom_role_on_downgrade();

-- -----------------------------------------------------------------------------
-- Audit Log Triggers
-- -----------------------------------------------------------------------------

-- Tamper-evidence hash chain: every insert is linked onto the previous row's
-- hash (see 32-audit-log.sql). BEFORE INSERT so client-supplied hash values
-- can never land.
CREATE OR REPLACE TRIGGER audit_log_hash_chain_trigger
    BEFORE INSERT ON public.audit_log
    FOR EACH ROW EXECUTE FUNCTION public.audit_log_hash_chain();


-- -----------------------------------------------------------------------------
-- Audit Column Triggers (backfill)
-- -----------------------------------------------------------------------------
--
-- Every table with created_by stamps it on insert, and every table with
-- updated_at stamps it on update. The convention was applied table by table
-- as features landed, so newer tables were missing it and their audit columns
-- sat unmaintained.
--
-- set_created_columns() coalesces, so a caller that passes created_by keeps it.
-- Tables with no updated_by take set_updated_at_only(); set_updated_columns()
-- assigns that field and would fail at runtime on a table without it.

-- created_by on insert
CREATE OR REPLACE TRIGGER on_insert_ai_cost_config_set_created_columns
    BEFORE INSERT ON public.ai_cost_config
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_billing_set_created_columns
    BEFORE INSERT ON public.billing
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_dashboard_set_created_columns
    BEFORE INSERT ON public.dashboard
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_dashboard_widget_set_created_columns
    BEFORE INSERT ON public.dashboard_widget
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_env_var_set_created_columns
    BEFORE INSERT ON public.env_var
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_environment_set_created_columns
    BEFORE INSERT ON public.environment
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_feature_flag_set_created_columns
    BEFORE INSERT ON public.feature_flag
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_feature_flag_override_set_created_columns
    BEFORE INSERT ON public.feature_flag_override
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_membership_set_created_columns
    BEFORE INSERT ON public.membership
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_platform_user_role_set_created_columns
    BEFORE INSERT ON public.platform_user_role
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_pull_request_set_created_columns
    BEFORE INSERT ON public.pull_request
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_sso_config_set_created_columns
    BEFORE INSERT ON public.sso_config
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_temp_access_grant_set_created_columns
    BEFORE INSERT ON public.temp_access_grant
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_tenant_set_created_columns
    BEFORE INSERT ON public.tenant
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_tenant_entitlement_override_set_created_columns
    BEFORE INSERT ON public.tenant_entitlement_override
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_terms_agreement_set_created_columns
    BEFORE INSERT ON public.terms_agreement
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_worker_run_set_created_columns
    BEFORE INSERT ON public.worker_run
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_insert_worker_workspace_set_created_columns
    BEFORE INSERT ON public.worker_workspace
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

-- updated_at only (no updated_by column)
CREATE OR REPLACE TRIGGER on_update_worker_run_set_updated_at
    BEFORE UPDATE ON public.worker_run
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_only();

CREATE OR REPLACE TRIGGER on_update_worker_workspace_set_updated_at
    BEFORE UPDATE ON public.worker_workspace
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_only();

-- -----------------------------------------------------------------------------
-- Realtime Subscriptions
-- -----------------------------------------------------------------------------

-- Enable realtime for tables that need live updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.notification;
ALTER PUBLICATION supabase_realtime ADD TABLE public.profile;

