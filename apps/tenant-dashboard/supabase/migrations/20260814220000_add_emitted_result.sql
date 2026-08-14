CREATE TABLE IF NOT EXISTS public.emitted_result (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES public.tenant(tenant_id) ON DELETE CASCADE,
    app_id UUID NOT NULL REFERENCES public.app(id) ON DELETE CASCADE,

    client_emit_id TEXT NOT NULL,

    name TEXT NOT NULL,
    result TEXT NOT NULL
        CONSTRAINT chk_emitted_result_result
        CHECK (result IN ('pass', 'fail')),
    link TEXT NOT NULL DEFAULT '',

    provenance TEXT NOT NULL
        CONSTRAINT chk_emitted_result_provenance
        CHECK (provenance IN ('ci', 'local')),

    repository TEXT NOT NULL,
    pr_number BIGINT NOT NULL,

    verification TEXT NOT NULL DEFAULT 'pending'
        CONSTRAINT chk_emitted_result_verification
        CHECK (verification IN ('pending', 'confirmed')),

    emitted_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_emitted_result_client UNIQUE (app_id, client_emit_id),

    -- Inline rather than a later ALTER: the table is brand-new and empty
    -- here, and a standalone ADD CONSTRAINT ... FOREIGN KEY takes a
    -- write-blocking lock on the referenced table.
    CONSTRAINT emitted_result_tenant_app_fk
        FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_emitted_result_pr
    ON public.emitted_result (tenant_id, repository, pr_number);
CREATE INDEX IF NOT EXISTS idx_emitted_result_tenant_id
    ON public.emitted_result (tenant_id);

ALTER TABLE public.emitted_result ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for tenant users" ON "public"."emitted_result"
    FOR SELECT TO "authenticated"
    USING (("app_id" IN ( SELECT "private"."authorized_app_ids"('trace.read'::"public"."app_permission"))
        AND (( SELECT "public"."tenant_id"() AS "tenant_id") = "tenant_id")));

REVOKE ALL ON public.emitted_result FROM anon;
REVOKE ALL ON public.emitted_result FROM authenticated;
GRANT SELECT ON public.emitted_result TO authenticated;
GRANT ALL ON public.emitted_result TO service_role;

GRANT SELECT, INSERT ON public.emitted_result TO gateway;

CREATE POLICY "gateway_tenant_read_emitted_result" ON public.emitted_result
    FOR SELECT TO gateway
    USING (tenant_id = public.tenant_id());

CREATE POLICY "gateway_tenant_insert_emitted_result" ON public.emitted_result
    FOR INSERT TO gateway
    WITH CHECK (tenant_id = public.tenant_id());
