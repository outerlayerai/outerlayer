-- =============================================================================
-- Tenant/App Consistency
-- =============================================================================
-- Purpose: Make "this row's tenant_id agrees with its app_id" a database
--          invariant rather than something every writer must remember.
-- Dependencies: every schema file declaring a table with both columns; must
--               load after all of them (hence 97) and after
--               20-app.sql, which declares the app_tenant_id_unique target key.
-- =============================================================================
--
-- Tenant isolation is enforced by RLS predicates over a denormalized
-- `tenant_id`. Nothing in the database made that column agree with the `app_id`
-- sitting beside it, so the isolation boundary rested on application code
-- writing both correctly on every path.
--
-- `api_key` shows why that matters. Its policies scope the same table two
-- different ways:
--
--   gateway_tenant_read_api_key                    ->  tenant_id = tenant_id()
--   Enable api_key delete for users with admin ...  ->  app_id IN authorized_app_ids(...)
--
-- One trusts tenant_id, the other trusts app_id. A row where they disagree is a
-- row the two policies disagree about. The constraints below make such a row
-- unwritable.
--
-- ON DELETE CASCADE is deliberate and is NOT redundant bookkeeping alongside
-- each table's existing single-column `app_id -> app(id) ON DELETE CASCADE`.
-- A composite FK left at the default NO ACTION turns app deletion into a
-- coin flip: the cascade trigger and the no-action check trigger are both AFTER
-- ROW triggers on `app`, and they fire in trigger-name order. If the cascade
-- happens to run first the children are gone and the check passes; if the check
-- runs first it sees live children and aborts the delete with
-- "still referenced from table ...". Neither order is guaranteed, and the order
-- changes if a constraint is ever dropped and recreated. Making both paths
-- CASCADE removes the ordering dependency: whichever fires first, the child row
-- is deleted and the other finds nothing.
--
-- ON UPDATE is left at NO ACTION on purpose. `app.id` and `app.tenant_id` are
-- immutable; an attempt to move an app between tenants should fail loudly
-- rather than silently rewrite every child row.
--
-- Note that these are MATCH SIMPLE (the default), which skips enforcement
-- entirely for any row where either key column is NULL. Both columns must
-- therefore be NOT NULL on every table listed here for the constraint to mean
-- anything -- see the comment on api_key.tenant_id.

ALTER TABLE public.api_key
    ADD CONSTRAINT api_key_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.app_member_role
    ADD CONSTRAINT app_member_role_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.context_blob
    ADD CONSTRAINT context_blob_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.context_head
    ADD CONSTRAINT context_head_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.context_snapshot
    ADD CONSTRAINT context_snapshot_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.context_sync_event
    ADD CONSTRAINT context_sync_event_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.context_tree_entry
    ADD CONSTRAINT context_tree_entry_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.dashboard
    ADD CONSTRAINT dashboard_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.env_var
    ADD CONSTRAINT env_var_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.environment
    ADD CONSTRAINT environment_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.git_branch
    ADD CONSTRAINT git_branch_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.git_connection
    ADD CONSTRAINT git_connection_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.pull_request
    ADD CONSTRAINT pull_request_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.pull_request_session
    ADD CONSTRAINT pull_request_session_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.artifact
    ADD CONSTRAINT artifact_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

-- saved_trace_filters is the one table here with no pre-existing app_id FK at
-- all, so this constraint is also what first ties its app_id to a real app.
ALTER TABLE public.saved_trace_filters
    ADD CONSTRAINT saved_trace_filters_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.worker_run
    ADD CONSTRAINT worker_run_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.worker_run_event
    ADD CONSTRAINT worker_run_event_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.worker_workspace
    ADD CONSTRAINT worker_workspace_tenant_app_fk
    FOREIGN KEY (tenant_id, app_id) REFERENCES public.app (tenant_id, id) ON DELETE CASCADE;
