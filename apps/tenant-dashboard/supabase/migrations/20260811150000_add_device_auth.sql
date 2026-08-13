-- Adds the CLI device-code login handshake table
-- (supabase/schemas/24-device-auth.sql) and its composite tenant/app
-- consistency FK (supabase/schemas/97-tenant-app-consistency.sql). Hand-
-- derived from the schema files to match `supabase db diff --local`'s output
-- style for an incremental migration.

  create table "public"."device_auth_request" (
    "id" uuid not null default gen_random_uuid(),
    "created_at" timestamp with time zone not null default now(),
    "expires_at" timestamp with time zone not null,
    "user_code" text not null,
    "device_code_digest" text not null,
    "status" text not null default 'pending'::text,
    "tenant_id" uuid,
    "app_id" uuid,
    "environment_id" uuid,
    "approver_membership_id" uuid,
    "approved_at" timestamp with time zone,
    "consumed_at" timestamp with time zone
      );


alter table "public"."device_auth_request" enable row level security;

CREATE UNIQUE INDEX device_auth_request_pkey ON public.device_auth_request USING btree (id);

CREATE INDEX idx_device_auth_request_expires_at ON public.device_auth_request USING btree (expires_at);

CREATE UNIQUE INDEX uc_device_auth_request_device_code_digest ON public.device_auth_request USING btree (device_code_digest);

CREATE UNIQUE INDEX uc_device_auth_request_user_code ON public.device_auth_request USING btree (user_code);

alter table "public"."device_auth_request" add constraint "device_auth_request_pkey" PRIMARY KEY using index "device_auth_request_pkey";

alter table "public"."device_auth_request" add constraint "chk_device_auth_request_status" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'consumed'::text]))) not valid;

alter table "public"."device_auth_request" validate constraint "chk_device_auth_request_status";

alter table "public"."device_auth_request" add constraint "device_auth_request_tenant_id_fkey" FOREIGN KEY (tenant_id) REFERENCES public.tenant(tenant_id) ON DELETE CASCADE not valid;

alter table "public"."device_auth_request" validate constraint "device_auth_request_tenant_id_fkey";

alter table "public"."device_auth_request" add constraint "device_auth_request_app_id_fkey" FOREIGN KEY (app_id) REFERENCES public.app(id) ON DELETE CASCADE not valid;

alter table "public"."device_auth_request" validate constraint "device_auth_request_app_id_fkey";

alter table "public"."device_auth_request" add constraint "device_auth_request_environment_id_fkey" FOREIGN KEY (environment_id) REFERENCES public.environment(id) ON DELETE SET NULL not valid;

alter table "public"."device_auth_request" validate constraint "device_auth_request_environment_id_fkey";

alter table "public"."device_auth_request" add constraint "device_auth_request_approver_membership_id_fkey" FOREIGN KEY (approver_membership_id) REFERENCES public.membership(id) ON DELETE SET NULL not valid;

alter table "public"."device_auth_request" validate constraint "device_auth_request_approver_membership_id_fkey";

alter table "public"."device_auth_request" add constraint "uc_device_auth_request_device_code_digest" UNIQUE using index "uc_device_auth_request_device_code_digest";

alter table "public"."device_auth_request" add constraint "uc_device_auth_request_user_code" UNIQUE using index "uc_device_auth_request_user_code";

alter table "public"."device_auth_request" add constraint "device_auth_request_tenant_app_fk" FOREIGN KEY (tenant_id, app_id) REFERENCES public.app(tenant_id, id) ON DELETE CASCADE not valid;

alter table "public"."device_auth_request" validate constraint "device_auth_request_tenant_app_fk";

-- The init migration's `ALTER DEFAULT PRIVILEGES` grants full CRUD to
-- anon/authenticated on every new table in this schema; the two REVOKEs
-- below close that for a table whose rows exist before any tenant is known
-- (RLS's `tenant_id = tenant_id()` policies have nothing to scope a pending
-- row against) — see 24-device-auth.sql for the full rationale. RLS stays
-- enabled with zero policies as a second, independent guard.
revoke all on public.device_auth_request from public, anon, authenticated;

grant select, insert, update on public.device_auth_request to service_role;
