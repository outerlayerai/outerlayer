-- =============================================================================
-- Profile Schema
-- =============================================================================
-- Purpose: User profile data linked to Supabase Auth users
-- Dependencies: 10-tenant.sql
-- Note: Profile is NOT tenant-scoped; users can belong to multiple tenants via membership
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Profile Table
-- -----------------------------------------------------------------------------

-- User profile linked to auth.users
-- Profiles are NOT tenant-scoped - users can belong to multiple organizations
CREATE TABLE IF NOT EXISTS public.profile (
    id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    name TEXT,
    avatar_url TEXT,
    email TEXT NOT NULL,
    github_username TEXT,
    updated_at TIMESTAMPTZ,
    -- The org the user last switched to; the CLI reads it to pick a default
    -- org. A preference only — NULL means "no recorded preference".
    last_active_tenant_id UUID,
    CONSTRAINT profile_pkey PRIMARY KEY (id),
    CONSTRAINT profile_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT github_username_unique UNIQUE (github_username),
    CONSTRAINT profile_last_active_tenant_id_fkey FOREIGN KEY (last_active_tenant_id)
        REFERENCES public.tenant(tenant_id) ON DELETE SET NULL
);

COMMENT ON TABLE public.profile IS 'Profile table with strict RLS - Users can only update their own profiles with profile.update permission, all DELETE operations blocked';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS profile_email_unique_lower ON public.profile(lower(email));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

-- Grant access to different roles
GRANT SELECT, INSERT, UPDATE ON public.profile TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.profile TO service_role;
GRANT SELECT ON public.profile TO anon;

-- Grant supabase_auth_admin UPDATE so auth.users triggers can sync email to profile
GRANT UPDATE ON TABLE public.profile TO supabase_auth_admin;

-- Explicitly revoke DELETE - profile deletion must go through auth.users CASCADE
-- This prevents phantom grant drift from db diff
REVOKE DELETE ON public.profile FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

ALTER TABLE public.profile ENABLE ROW LEVEL SECURITY;

-- Note: The "Users can read profiles" policy is defined in 12-rbac.sql
-- because it depends on the membership table which is created there.

-- Note: The "Users can update own profile" policy is defined in 12-rbac.sql
-- to keep all profile policies together.

