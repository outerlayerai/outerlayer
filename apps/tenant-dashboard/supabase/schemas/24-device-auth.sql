-- =============================================================================
-- Device Auth Request (CLI device-code login)
-- =============================================================================
-- Purpose: state for the `outerlayer login` device-code handshake — a code is
--   requested unauthenticated, approved by a signed-in user in the dashboard,
--   then consumed exactly once by the polling CLI to mint an API key.
-- Dependencies: 10-tenant.sql, 12-rbac.sql (membership), 20-app.sql,
--   52-environment.sql
-- =============================================================================
--
-- Rows exist BEFORE any tenant is known (the /start request is unauthenticated
-- by design — the whole point is a machine with no credentials yet). That
-- makes this table pre-tenant data, not tenant data: RLS's normal `tenant_id =
-- tenant_id()` policies have nothing to scope against for a pending row, and
-- letting anon/authenticated reach it via PostgREST at all would let one
-- unauthenticated caller enumerate or tamper with another's in-flight login.
-- So, per the private.api_key_secret idiom (23a-api-key-secret.sql): RLS
-- ENABLED with ZERO policies (default-deny even if grants existed), plus
-- explicit REVOKEs so no ambient default privilege can put a row within reach
-- of anon/authenticated. The ONLY access path is
-- apps/tenant-dashboard/src/lib/system/device-auth.ts, which reads and writes
-- through the service-role admin client.
--
-- device_code is the CLI's bearer secret for this handshake (32 CSPRNG bytes,
-- base64url) and is stored ONLY as its HMAC digest (hashApiKey, same pepper
-- and algorithm as api_key) — never in plaintext, mirroring
-- private.api_key_secret's key_digest treatment. user_code is the short,
-- human-typed code shown in the dashboard; it is not a secret (an 8-char
-- Crockford base32 code the *user* enters after already being signed in), so
-- it is stored as plain text.

CREATE TABLE IF NOT EXISTS public.device_auth_request (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 10-minute TTL from creation, mirroring GIT_CONNECT_STATE_TTL_SECONDS'
    -- short-lived-state-token discipline. Checked at both approval and poll —
    -- an expired row can never transition again regardless of which endpoint
    -- notices first.
    expires_at TIMESTAMPTZ NOT NULL,

    user_code TEXT NOT NULL,
    device_code_digest TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT chk_device_auth_request_status
        CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),

    -- NULL until approval: the request is created before any tenant/app is
    -- chosen. Both are set together by the approval action.
    tenant_id UUID REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID REFERENCES public.app(id) ON DELETE CASCADE,
    environment_id UUID REFERENCES public.environment(id) ON DELETE SET NULL,
    -- The approving member's own membership id (never their email/user id) —
    -- what the minted key's actor_membership_id is stamped with, and what the
    -- api_key_created audit row attributes to.
    approver_membership_id UUID REFERENCES public.membership(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    -- Set inside the same atomic UPDATE that flips status to 'consumed' — see
    -- consume_device_auth_request in this file. Never set independently.
    consumed_at TIMESTAMPTZ,

    CONSTRAINT uc_device_auth_request_user_code UNIQUE (user_code),
    CONSTRAINT uc_device_auth_request_device_code_digest UNIQUE (device_code_digest)
);

COMMENT ON TABLE public.device_auth_request IS 'CLI device-code login handshake state — pre-tenant, service-role access only, see file header';

CREATE INDEX IF NOT EXISTS idx_device_auth_request_expires_at ON public.device_auth_request(expires_at);

-- -----------------------------------------------------------------------------
-- RLS: enabled, zero policies (default-deny), explicit revokes
-- -----------------------------------------------------------------------------

ALTER TABLE public.device_auth_request ENABLE ROW LEVEL SECURITY;

-- Belt-and-suspenders alongside the zero-policy RLS above: no ambient default
-- privilege (this project's own legacy grant or a future one) can hand
-- anon/authenticated a table privilege here. Only service_role — the identity
-- src/lib/system/device-auth.ts authenticates as — may touch this table.
--
-- service_role's Postgres role carries BYPASSRLS, so no SECURITY DEFINER RPC
-- is needed for the single-use approve→consume transition either: the poll
-- path issues a plain UPDATE ... WHERE status='approved' AND consumed_at IS
-- NULL ... RETURNING directly (see lib/system/device-auth.ts). Postgres
-- serializes concurrent UPDATEs to the same row, and a WHERE clause carrying
-- the transition's own precondition means only the first of two concurrent
-- polls ever matches a row — the second's WHERE no longer holds once the
-- first commits, so it returns zero rows and must not mint. That is the
-- entire single-use guarantee; it needs no stored procedure to hold.
REVOKE ALL ON public.device_auth_request FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.device_auth_request TO service_role;
