
  create table "public"."signup_domain_allowlist" (
    "domain" text not null,
    "created_at" timestamp with time zone not null default now()
      );


alter table "public"."signup_domain_allowlist" enable row level security;

CREATE UNIQUE INDEX signup_domain_allowlist_pkey ON public.signup_domain_allowlist USING btree (domain);

alter table "public"."signup_domain_allowlist" add constraint "signup_domain_allowlist_pkey" PRIMARY KEY using index "signup_domain_allowlist_pkey";

alter table "public"."signup_domain_allowlist" add constraint "signup_domain_allowlist_domain_normalized" CHECK (((domain = lower(btrim(domain))) AND (domain <> ''::text) AND (domain !~~ '@%'::text))) not valid;

alter table "public"."signup_domain_allowlist" validate constraint "signup_domain_allowlist_domain_normalized";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.before_user_created_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  signup_domain text;
begin
  -- Empty allowlist = gate off. See the file header: which environments gate
  -- signups is data, so an unseeded environment must behave as ungated.
  if not exists (select 1 from public.signup_domain_allowlist) then
    return '{}'::jsonb;
  end if;

  signup_domain := lower(split_part(coalesce(event->'user'->>'email', ''), '@', 2));

  if signup_domain <> '' and exists (
    select 1 from public.signup_domain_allowlist
    where domain = signup_domain
  ) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Signups on this environment are restricted to approved email domains.'
    )
  );
end;
$function$
;

grant delete on table "public"."signup_domain_allowlist" to "anon";

grant insert on table "public"."signup_domain_allowlist" to "anon";

grant select on table "public"."signup_domain_allowlist" to "anon";

grant update on table "public"."signup_domain_allowlist" to "anon";

grant delete on table "public"."signup_domain_allowlist" to "authenticated";

grant insert on table "public"."signup_domain_allowlist" to "authenticated";

grant select on table "public"."signup_domain_allowlist" to "authenticated";

grant update on table "public"."signup_domain_allowlist" to "authenticated";

grant delete on table "public"."signup_domain_allowlist" to "service_role";

grant insert on table "public"."signup_domain_allowlist" to "service_role";

grant references on table "public"."signup_domain_allowlist" to "service_role";

grant select on table "public"."signup_domain_allowlist" to "service_role";

grant trigger on table "public"."signup_domain_allowlist" to "service_role";

grant truncate on table "public"."signup_domain_allowlist" to "service_role";

grant update on table "public"."signup_domain_allowlist" to "service_role";

grant select on table "public"."signup_domain_allowlist" to "supabase_auth_admin";


  create policy "service_role_all"
  on "public"."signup_domain_allowlist"
  as permissive
  for all
  to public
using ((( SELECT auth.role() AS role) = 'service_role'::text));

-- db diff does not emit function ACLs or comments; added by hand to stay in
-- sync with schemas/14-signup-allowlist.sql and
-- schemas/96-function-execution-grants.sql. The revoke matters: functions are
-- born with EXECUTE for PUBLIC, which would expose the hook as an anon-callable
-- PostgREST RPC.
GRANT EXECUTE ON FUNCTION public.before_user_created_hook(jsonb) TO supabase_auth_admin;

REVOKE EXECUTE ON FUNCTION public.before_user_created_hook(jsonb) FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.signup_domain_allowlist IS 'Email domains allowed to sign up while the before-user-created auth hook is active; empty table disables the gate';



