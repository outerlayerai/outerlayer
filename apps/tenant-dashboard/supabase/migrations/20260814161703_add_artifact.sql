-- Adds the artifact table (supabase/schemas/78-artifact.sql): one row per
-- emitted exhibit (screenshot, recording, report, log) anchored to a pull
-- request, with gateway-role ingest grants (95-gateway-rls.sql), the
-- tenant-app composite FK (97-tenant-app-consistency.sql), and the
-- updated_at trigger (99-triggers.sql). Also grants the gateway read access
-- to pull_request so artifact ingest can confirm a claimed PR number against
-- the webhook-fed record. `supabase db diff` output trimmed to this change's
-- footprint: the generator also emitted revoke statements for pre-existing
-- privilege drift on unrelated tables, which do not belong to this change.
-- The explicit anon/authenticated revokes below are required because the
-- init migration's ALTER DEFAULT PRIVILEGES grants full CRUD to
-- anon/authenticated on every new table in this schema.

  create table "public"."artifact" (
    "id" uuid not null default gen_random_uuid(),
    "tenant_id" uuid not null,
    "app_id" uuid not null,
    "client_artifact_id" text not null,
    "sha256" text not null,
    "filename" text not null,
    "media_type" text not null,
    "kind" text not null,
    "caption" text not null default ''::text,
    "criterion_id" text not null default ''::text,
    "provenance" text not null,
    "session_id" text not null default ''::text,
    "trace_id" text not null default ''::text,
    "turn_index" bigint,
    "repository" text not null default ''::text,
    "pr_number" bigint,
    "git_repo" text not null default ''::text,
    "git_branch" text not null default ''::text,
    "commit_sha" text not null default ''::text,
    "verification" text not null default 'pending'::text,
    "blob_deleted" boolean not null default false,
    "emitted_at" timestamp with time zone not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "last_reconciled_at" timestamp with time zone not null default now()
      );


alter table "public"."artifact" enable row level security;

CREATE UNIQUE INDEX artifact_pkey ON public.artifact USING btree (id);

CREATE INDEX idx_artifact_app_trace ON public.artifact USING btree (app_id, trace_id) WHERE (trace_id <> ''::text);

CREATE INDEX idx_artifact_pending ON public.artifact USING btree (verification, emitted_at) WHERE (verification = 'pending'::text);

CREATE INDEX idx_artifact_pr ON public.artifact USING btree (tenant_id, repository, pr_number) WHERE (pr_number IS NOT NULL);

CREATE INDEX idx_artifact_tenant_id ON public.artifact USING btree (tenant_id);

CREATE INDEX idx_artifact_unmatched_blob ON public.artifact USING btree (verification) WHERE ((verification = 'unmatched'::text) AND (NOT blob_deleted));

CREATE UNIQUE INDEX uq_artifact_client ON public.artifact USING btree (app_id, client_artifact_id);

alter table "public"."artifact" add constraint "artifact_pkey" PRIMARY KEY using index "artifact_pkey";

alter table "public"."artifact" add constraint "artifact_app_id_fkey" FOREIGN KEY (app_id) REFERENCES public.app(id) ON DELETE CASCADE not valid;

alter table "public"."artifact" validate constraint "artifact_app_id_fkey";

alter table "public"."artifact" add constraint "artifact_tenant_app_fk" FOREIGN KEY (tenant_id, app_id) REFERENCES public.app(tenant_id, id) ON DELETE CASCADE not valid;

alter table "public"."artifact" validate constraint "artifact_tenant_app_fk";

alter table "public"."artifact" add constraint "artifact_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenant(tenant_id) ON DELETE CASCADE not valid;

alter table "public"."artifact" validate constraint "artifact_tenant_id_fkey";

alter table "public"."artifact" add constraint "chk_artifact_kind" CHECK ((kind = ANY (ARRAY['video'::text, 'screenshot'::text, 'report'::text, 'log'::text, 'file'::text]))) not valid;

alter table "public"."artifact" validate constraint "chk_artifact_kind";

alter table "public"."artifact" add constraint "chk_artifact_provenance" CHECK ((provenance = ANY (ARRAY['session'::text, 'ci'::text, 'local'::text]))) not valid;

alter table "public"."artifact" validate constraint "chk_artifact_provenance";

alter table "public"."artifact" add constraint "chk_artifact_verification" CHECK ((verification = ANY (ARRAY['pending'::text, 'confirmed'::text, 'unmatched'::text]))) not valid;

alter table "public"."artifact" validate constraint "chk_artifact_verification";

alter table "public"."artifact" add constraint "uq_artifact_client" UNIQUE using index "uq_artifact_client";

revoke all on table "public"."artifact" from "anon";

revoke all on table "public"."artifact" from "authenticated";

grant select on table "public"."artifact" to "authenticated";

grant insert on table "public"."artifact" to "gateway";

grant select on table "public"."artifact" to "gateway";

grant update on table "public"."artifact" to "gateway";

grant all on table "public"."artifact" to "service_role";

grant select on table "public"."pull_request" to "gateway";


  create policy "Enable read access for tenant users"
  on "public"."artifact"
  as permissive
  for select
  to authenticated
using (((app_id IN ( SELECT private.authorized_app_ids('trace.read'::public.app_permission) AS authorized_app_ids)) AND (( SELECT public.tenant_id() AS tenant_id) = tenant_id)));



  create policy "gateway_tenant_insert_artifact"
  on "public"."artifact"
  as permissive
  for insert
  to gateway
with check ((tenant_id = public.tenant_id()));



  create policy "gateway_tenant_read_artifact"
  on "public"."artifact"
  as permissive
  for select
  to gateway
using ((tenant_id = public.tenant_id()));



  create policy "gateway_tenant_update_artifact"
  on "public"."artifact"
  as permissive
  for update
  to gateway
using ((tenant_id = public.tenant_id()))
with check ((tenant_id = public.tenant_id()));



  create policy "gateway_tenant_read_pull_request"
  on "public"."pull_request"
  as permissive
  for select
  to gateway
using ((tenant_id = public.tenant_id()));


CREATE TRIGGER on_update_artifact_set_updated_at BEFORE UPDATE ON public.artifact FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_only();
