-- Adds the pr-session-comment identity table and the per-app toggle column
-- on git_connection that gates it (supabase/schemas/76-pr-session-comment.sql,
-- supabase/schemas/22-git-connection.sql). `supabase db diff` generates the
-- table/column/index/policy/trigger correctly but does not emit the
-- column-level grant `pr_comments_enabled` needs on git_connection -- that
-- table uses per-column grants (REVOKE ALL + explicit re-grant per column;
-- see 22-git-connection.sql), so a column added without its own grant
-- inherits none and every PostgREST select/insert/update naming it 42501s.
-- The grant below is hand-added to close that gap; `supabase db diff --local`
-- reports zero drift against the schema files with it in place.

  create table "public"."pr_session_comment" (
    "id" uuid not null default gen_random_uuid(),
    "tenant_id" uuid not null,
    "repository" text not null,
    "pr_number" bigint not null,
    "github_comment_id" bigint,
    "last_body_hash" text not null default ''::text,
    "last_posted_at" timestamp with time zone,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
      );


alter table "public"."pr_session_comment" enable row level security;

-- Opt-in by default: this backfills every already-connected repo, and
-- defaulting on would post a bot comment nobody enabled on their next PR.
alter table "public"."git_connection" add column "pr_comments_enabled" boolean not null default false;

-- `supabase db diff` did not emit this column-level grant for the new
-- column (see the header comment above) -- hand-added to match
-- 22-git-connection.sql's explicit SELECT/INSERT/UPDATE column lists for
-- "authenticated", which already include pr_comments_enabled.
grant select (pr_comments_enabled), insert (pr_comments_enabled), update (pr_comments_enabled)
    on public.git_connection to authenticated;

CREATE INDEX idx_pr_session_comment_tenant_id ON public.pr_session_comment USING btree (tenant_id);

CREATE UNIQUE INDEX pr_session_comment_pkey ON public.pr_session_comment USING btree (id);

CREATE UNIQUE INDEX uq_pr_session_comment ON public.pr_session_comment USING btree (tenant_id, repository, pr_number);

alter table "public"."pr_session_comment" add constraint "pr_session_comment_pkey" PRIMARY KEY using index "pr_session_comment_pkey";

alter table "public"."pr_session_comment" add constraint "pr_session_comment_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenant(tenant_id) ON DELETE CASCADE not valid;

alter table "public"."pr_session_comment" validate constraint "pr_session_comment_tenant_id_fkey";

alter table "public"."pr_session_comment" add constraint "uq_pr_session_comment" UNIQUE using index "uq_pr_session_comment";

grant delete on table "public"."pr_session_comment" to "anon";

grant insert on table "public"."pr_session_comment" to "anon";

grant select on table "public"."pr_session_comment" to "anon";

grant update on table "public"."pr_session_comment" to "anon";

grant delete on table "public"."pr_session_comment" to "authenticated";

grant insert on table "public"."pr_session_comment" to "authenticated";

grant select on table "public"."pr_session_comment" to "authenticated";

grant update on table "public"."pr_session_comment" to "authenticated";

grant delete on table "public"."pr_session_comment" to "service_role";

grant insert on table "public"."pr_session_comment" to "service_role";

grant references on table "public"."pr_session_comment" to "service_role";

grant select on table "public"."pr_session_comment" to "service_role";

grant trigger on table "public"."pr_session_comment" to "service_role";

grant truncate on table "public"."pr_session_comment" to "service_role";

grant update on table "public"."pr_session_comment" to "service_role";


  create policy "Enable read access for tenant users"
  on "public"."pr_session_comment"
  as permissive
  for select
  to authenticated
using ((( SELECT public.tenant_id() AS tenant_id) = tenant_id));


CREATE TRIGGER on_update_pr_session_comment_set_updated_at BEFORE UPDATE ON public.pr_session_comment FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_only();


