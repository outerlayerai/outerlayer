-- Hardens the artifact surface (supabase/schemas/78-artifact.sql,
-- 95-gateway-rls.sql, 99-triggers.sql):
--   * The gateway role holds no UPDATE on artifact — a retried ingest
--     inserts with ON CONFLICT DO NOTHING, and the sweeps that mutate rows
--     (verification aging, blob_deleted stamping) run under service_role —
--     so the grant and policy are revoked/dropped as unreachable surface.
--   * idx_artifact_app_sha backs the blob sweep's shared-sha liveness count
--     (blobs are content-addressed and shared; before deleting bytes the
--     sweep counts other live claims on the same (tenant, app, sha)).
--   * artifact gets the same set_tenant_id() BEFORE INSERT trigger as every
--     other gateway-writable tenant-scoped table, so a forged tenant_id is
--     silently corrected to the caller's tenant instead of relying on the
--     WITH CHECK alone.

revoke update on table "public"."artifact" from "gateway";

drop policy "gateway_tenant_update_artifact" on "public"."artifact";

CREATE INDEX idx_artifact_app_sha ON public.artifact USING btree (app_id, sha256);

CREATE TRIGGER on_insert_artifact_set_tenant_id BEFORE INSERT ON public.artifact FOR EACH ROW EXECUTE FUNCTION public.set_tenant_id();
