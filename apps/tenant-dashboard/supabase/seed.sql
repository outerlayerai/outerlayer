-- =============================================================================
-- Seed Data for Preview Branches
-- =============================================================================
-- Runs AFTER all migrations. Provides minimum viable data for testing:
--   1. Auth user (demo@outerlayer.ai)
--   2. Tenant (outerlayer-test)
--   3. Profile
--   4. Membership (owner role)
--   5. App (test-app)
--   6. Platform admin role
--   7. Terms agreement (bypasses terms gate)
--
-- All IDs are deterministic UUIDs so the seed is idempotent.
--
-- Note: We set myvars.pg_client_role = 'service_role' so that the
-- set_tenant_id() trigger uses the explicitly provided tenant_id rather
-- than trying to read request.jwt.claims (which doesn't exist in seeds).
-- =============================================================================

DO $$
DECLARE
  v_user_id     UUID := 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  v_tenant_id   UUID := 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
  v_app_id      UUID := 'c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f';
  -- Local-only credential. This file runs solely through `[db.seed]` in
  -- config.toml, i.e. on `supabase start` / `db reset` against the local
  -- container — never against a hosted project. The value is deliberately
  -- self-describing so it can never be mistaken for, or reused as, a real
  -- environment's password. No deployed environment may ever share a password
  -- string with this seed.
  v_password    TEXT := 'local-dev-only-NotASecret1';
BEGIN
  -- Let triggers know we're running as service_role so they use the provided
  -- tenant_id instead of reading from JWT claims.
  PERFORM set_config('myvars.pg_client_role', 'service_role', true);

  -- -------------------------------------------------------------------------
  -- 1. Auth User
  -- -------------------------------------------------------------------------
  -- app_metadata.role: read by getCurrentUserPermissions() for frontend perms
  -- user_metadata.display_name: read throughout the app for display name
  -- Token columns must be '' not NULL to avoid GoTrue Go scanner crash
  INSERT INTO auth.users (
    id,
    instance_id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change,
    email_change_token_current,
    phone,
    phone_change,
    phone_change_token,
    reauthentication_token
  ) VALUES (
    v_user_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'demo@outerlayer.ai',
    extensions.crypt(v_password, extensions.gen_salt('bf')),
    NOW(),
    jsonb_build_object(
      'provider', 'email',
      'providers', ARRAY['email'],
      'tenant_id', v_tenant_id,
      'role', 'owner'
    ),
    jsonb_build_object(
      'display_name', 'Demo User'
    ),
    NOW(),
    NOW(),
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    ''
  )
  ON CONFLICT (id) DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 2. Auth Identity (required for email/password login)
  -- -------------------------------------------------------------------------
  INSERT INTO auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at
  ) VALUES (
    gen_random_uuid(),
    v_user_id,
    jsonb_build_object(
      'sub', v_user_id::TEXT,
      'email', 'demo@outerlayer.ai',
      'email_verified', true
    ),
    'email',
    v_user_id::TEXT,
    NOW(),
    NOW(),
    NOW()
  )
  ON CONFLICT ON CONSTRAINT identities_provider_id_provider_unique DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 3. Tenant
  -- -------------------------------------------------------------------------
  INSERT INTO public.tenant (
    tenant_id,
    organization_name,
    company_name,
    created_at,
    created_by
  ) VALUES (
    v_tenant_id,
    'outerlayer-test',
    'OuterLayer Test',
    NOW(),
    v_user_id
  )
  ON CONFLICT (tenant_id) DO NOTHING;

  -- New tenants do not provision a "Gateway System" fake user.
  -- set_created_columns()/set_updated_columns() own created_by/updated_by for the
  -- gateway role (NULL for machine writes), so a gateway JWT with sub = tenant_id
  -- does not trip the profile FK.

  -- -------------------------------------------------------------------------
  -- 4. Profile
  -- -------------------------------------------------------------------------
  INSERT INTO public.profile (
    id,
    email,
    name,
    created_at
  ) VALUES (
    v_user_id,
    'demo@outerlayer.ai',
    'Demo User',
    NOW()
  )
  ON CONFLICT ON CONSTRAINT profile_pkey DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 5. Membership (owner role, active status)
  -- -------------------------------------------------------------------------
  INSERT INTO public.membership (
    user_id,
    tenant_id,
    role,
    status,
    accepted_at,
    created_at,
    created_by
  ) VALUES (
    v_user_id,
    v_tenant_id,
    'owner',
    'active',
    NOW(),
    NOW(),
    v_user_id
  )
  ON CONFLICT ON CONSTRAINT membership_user_tenant_unique DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 6. App
  -- -------------------------------------------------------------------------
  INSERT INTO public.app (
    id,
    tenant_id,
    name,
    created_at,
    created_by
  ) VALUES (
    v_app_id,
    v_tenant_id,
    'test-app',
    NOW(),
    v_user_id
  )
  ON CONFLICT (id) DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 6b. Default environment
  -- -------------------------------------------------------------------------
  -- seed.sql runs AFTER the migrations, so the per-app default-env data
  -- migration (20260524150001, default-env seed section) has already executed and does NOT cover this
  -- app. Production apps get their default env from the createApp server
  -- action; a raw seed INSERT must seed the default env itself, otherwise the
  -- "every app has exactly one default env" invariant is violated locally.
  INSERT INTO public.environment (
    tenant_id,
    app_id,
    name,
    is_default,
    current_version,
    fly_app_name,
    created_at,
    created_by
  ) VALUES (
    v_tenant_id,
    v_app_id,
    'dev',
    true,
    0,
    NULL,
    NOW(),
    v_user_id
  )
  ON CONFLICT (app_id, name) DO NOTHING;

  -- Mark the app as having completed the env migration (consistent with a
  -- post-migration production app).
  UPDATE public.app
    SET environment_migration_done_at = NOW()
    WHERE id = v_app_id;

  -- -------------------------------------------------------------------------
  -- 7. Platform Admin Role
  -- -------------------------------------------------------------------------
  INSERT INTO public.platform_user_role (
    user_id,
    role,
    created_at,
    created_by
  ) VALUES (
    v_user_id,
    'platform_admin',
    NOW(),
    v_user_id
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 8. Terms Agreement (bypasses TermsGuard redirect)
  -- -------------------------------------------------------------------------
  -- Version must match NEXT_PUBLIC_TERMS_VERSION (default: '2026-01-10')
  INSERT INTO public.terms_agreement (
    user_id,
    terms_version,
    agreed_at,
    consent_type,
    created_by
  ) VALUES (
    v_user_id,
    '2026-01-10',
    NOW(),
    'explicit',
    v_user_id
  )
  ON CONFLICT ON CONSTRAINT terms_agreement_user_version_unique DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 9. Git Connection (required for templates layout to show editor)
  -- -------------------------------------------------------------------------
  -- session_replication_role=replica is set in the wrapping DO block's caller
  -- to bypass the set_tenant_id trigger which needs JWT claims.
  -- We handle it here by direct SQL instead.
  INSERT INTO public.git_connection (
    id,
    tenant_id,
    app_id,
    provider,
    repository,
    installation_id,
    created_by
  ) VALUES (
    'c4d5e6f7-a8b9-4c0d-9e2f-3a4b5c6d7e8f',
    v_tenant_id,
    v_app_id,
    'github',
    'outerlayer-test/test-app',
    99999,
    v_user_id
  )
  ON CONFLICT ON CONSTRAINT uc_git_connection DO NOTHING;

  -- -------------------------------------------------------------------------
  -- 11. Git Branch
  -- -------------------------------------------------------------------------
  INSERT INTO public.git_branch (
    id,
    tenant_id,
    app_id,
    branch_name,
    repo,
    created_at,
    created_by
  ) VALUES (
    'd4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f8a',
    v_tenant_id,
    v_app_id,
    'main',
    'outerlayer-test/test-app',
    NOW(),
    v_user_id
  )
  ON CONFLICT ON CONSTRAINT unique_git_repo_branch_constraint DO NOTHING;

END $$;
