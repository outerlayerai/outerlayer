-- =============================================================================
-- Terms Agreement Schema
-- =============================================================================
-- Purpose: Track user agreement to terms of service
-- Dependencies: 11-profile.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Terms Agreement Table
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.terms_agreement (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    terms_version TEXT NOT NULL,
    agreed_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    created_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ,
    updated_by UUID REFERENCES public.profile(id) ON DELETE SET NULL,
    consent_type TEXT DEFAULT 'explicit' NOT NULL,
    CONSTRAINT terms_agreement_consent_type_check CHECK (consent_type IN ('explicit', 'implicit')),
    CONSTRAINT terms_agreement_user_version_unique UNIQUE (user_id, terms_version),
    CONSTRAINT terms_agreement_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profile(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.terms_agreement IS 'Audit trail of user terms of service agreements';
COMMENT ON COLUMN public.terms_agreement.consent_type IS 'Type of consent: explicit (checkbox) or implicit';

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_terms_agreement_consent_type ON public.terms_agreement(consent_type);
CREATE INDEX IF NOT EXISTS idx_terms_agreement_version ON public.terms_agreement(terms_version);

-- -----------------------------------------------------------------------------
-- RLS Policies
-- -----------------------------------------------------------------------------

ALTER TABLE public.terms_agreement ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON "public"."terms_agreement" TO "service_role" USING (true) WITH CHECK (true);

CREATE POLICY "users_can_view_own_agreements" ON "public"."terms_agreement" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.terms_agreement TO authenticated;
GRANT ALL ON public.terms_agreement TO service_role;
