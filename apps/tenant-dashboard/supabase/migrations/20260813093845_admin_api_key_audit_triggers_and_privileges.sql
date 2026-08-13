-- Wires admin_api_key into the two schema-wide conventions its own creation
-- migration (20260812174724_admin_api_key.sql) left unapplied:
--
-- 1. The audit-column triggers every created_by/updated_at table carries
--    (public.set_created_columns / public.set_updated_columns), so the
--    columns are stamped by the database rather than sitting unmaintained.
-- 2. TRUNCATE/REFERENCES/TRIGGER for `authenticated`, stripped everywhere
--    else by 98-table-privilege-hardening.sql's default-privilege rule.
--    That rule only binds tables created after it ran; admin_api_key's own
--    `GRANT ALL ON public.admin_api_key TO authenticated` re-added the three
--    privileges the default-privilege revoke had stripped at creation, and
--    nothing revoked them back afterward.

CREATE OR REPLACE TRIGGER on_insert_admin_api_key_set_created_columns
    BEFORE INSERT ON public.admin_api_key
    FOR EACH ROW EXECUTE FUNCTION public.set_created_columns();

CREATE OR REPLACE TRIGGER on_update_set_admin_api_key_updated_columns
    BEFORE UPDATE ON public.admin_api_key
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_columns();

REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.admin_api_key FROM authenticated;
