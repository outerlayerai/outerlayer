-- =============================================================================
-- Storage Policies
-- =============================================================================
-- Purpose: RLS policies for Supabase Storage buckets (avatar)
-- Dependencies: 02-functions-core.sql (tenant_id, authorize functions)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Avatar Bucket Policies
-- -----------------------------------------------------------------------------

-- Every policy is owner-scoped. A bucket-and-role-only predicate is not enough
-- here: object names are derived from user UUIDs, so any authenticated caller
-- would be able to read, overwrite (`x-upsert`) and enumerate other tenants'
-- avatars.
--
-- SELECT is owner-scoped too, not merely path-prefixed, because nothing reads
-- another user's avatar (`useProfile` filters `.eq('id', user.id)`; the account
-- popover reads the signed-in user's own row). That also closes the roster
-- enumeration a prefix-only fix would leave behind — folder names would still
-- list as user UUIDs.
--
-- Ownership is expressed two ways because both layouts exist:
--   new     `{uid}/avatar.png`  → (storage.foldername(name))[1] = uid
--   legacy  `{uid}.png`         → name LIKE uid || '.%' at the bucket root
-- The legacy arm keeps pre-existing avatars readable by their owner and matches
-- only a root object whose basename is the caller's own uid. Drop it once no
-- root-level objects remain.

CREATE POLICY "avatar_select_own"
    ON storage.objects FOR SELECT
    TO authenticated
    USING ((bucket_id = 'avatar'::text) AND ((((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text) OR (name ~~ ((( SELECT auth.uid() AS uid))::text || '.%'::text)))));

CREATE POLICY "avatar_insert_own"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (((bucket_id = 'avatar'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));

-- WITH CHECK repeats the predicate so an owner cannot rename their object into
-- another user's folder.
CREATE POLICY "avatar_update_own"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING ((bucket_id = 'avatar'::text) AND ((((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text) OR (name ~~ ((( SELECT auth.uid() AS uid))::text || '.%'::text)))))
    WITH CHECK (((bucket_id = 'avatar'::text) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));

-- Owners may remove their own avatar; without this policy there is no delete
-- path at all.
CREATE POLICY "avatar_delete_own"
    ON storage.objects FOR DELETE
    TO authenticated
    USING ((bucket_id = 'avatar'::text) AND ((((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text) OR (name ~~ ((( SELECT auth.uid() AS uid))::text || '.%'::text)))));
