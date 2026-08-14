-- Adds the append-only pr_evidence_evaluation record table
-- (supabase/schemas/77-pr-evidence-evaluation.sql): every evidence
-- evaluation's facts + verdict per (tenant, repository, pr_number), so
-- verdicts are queryable against PR merge/revert outcomes from day one.

  create table "public"."pr_evidence_evaluation" (
    "id" uuid not null default gen_random_uuid(),
    "tenant_id" uuid not null,
    "repository" text not null,
    "pr_number" bigint not null,
    "verdict" text not null,
    "facts" jsonb not null default '[]'::jsonb,
    "pending_link_count" bigint not null default 0,
    "evaluated_at" timestamp with time zone not null default now()
      );


alter table "public"."pr_evidence_evaluation" enable row level security;

CREATE UNIQUE INDEX pr_evidence_evaluation_pkey ON public.pr_evidence_evaluation USING btree (id);

CREATE INDEX idx_pr_evidence_evaluation_pr ON public.pr_evidence_evaluation USING btree (tenant_id, repository, pr_number, evaluated_at DESC);

alter table "public"."pr_evidence_evaluation" add constraint "pr_evidence_evaluation_pkey" PRIMARY KEY using index "pr_evidence_evaluation_pkey";

alter table "public"."pr_evidence_evaluation" add constraint "pr_evidence_evaluation_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenant(tenant_id) ON DELETE CASCADE not valid;

alter table "public"."pr_evidence_evaluation" validate constraint "pr_evidence_evaluation_tenant_id_fkey";

alter table "public"."pr_evidence_evaluation" add constraint "pr_evidence_evaluation_verdict_check" CHECK ((verdict = ANY (ARRAY['pass'::text, 'flag'::text, 'unverifiable'::text, 'waiting'::text]))) not valid;

alter table "public"."pr_evidence_evaluation" validate constraint "pr_evidence_evaluation_verdict_check";

-- Same posture as 20260806170031_add_pr_session_comment.sql: the init
-- migration bakes in legacy `ALTER DEFAULT PRIVILEGES` granting full CRUD to
-- anon/authenticated on every new table in this schema, so the inherited
-- grants are stripped first and only what is actually used is re-granted.
revoke all on table "public"."pr_evidence_evaluation" from "anon";

revoke all on table "public"."pr_evidence_evaluation" from "authenticated";

grant select on table "public"."pr_evidence_evaluation" to "authenticated";

grant delete on table "public"."pr_evidence_evaluation" to "service_role";

grant insert on table "public"."pr_evidence_evaluation" to "service_role";

grant references on table "public"."pr_evidence_evaluation" to "service_role";

grant select on table "public"."pr_evidence_evaluation" to "service_role";

grant trigger on table "public"."pr_evidence_evaluation" to "service_role";

grant truncate on table "public"."pr_evidence_evaluation" to "service_role";

grant update on table "public"."pr_evidence_evaluation" to "service_role";


  create policy "Enable read access for tenant users"
  on "public"."pr_evidence_evaluation"
  as permissive
  for select
  to authenticated
using ((( SELECT public.tenant_id() AS tenant_id) = tenant_id));
