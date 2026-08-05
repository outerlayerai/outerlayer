import { useEffect, useState } from "react";
import { useAuthContext } from "../auth/hooks";
import { Profile } from "../types/profile";
import { createSupabaseFontendClient } from "../supabaseFrontendClient";

export const useProfile = () => {
  const [profile, setProfile] = useState<Profile>();

  const { user } = useAuthContext();

  const supabase = createSupabaseFontendClient();

  const getSingle = async (select: string = "*") => {
    const { data, error } = await supabase
      .from("profile")
      .select(select)
      .eq("id", user?.id!)
      .single<Profile>();
    if (error) {
      throw new Error(error.message);
    }
    if (data.avatar_url) {
      const { data: avatar, error } = await supabase.storage
        .from("avatar")
        .download(data.avatar_url);
      if (error) {
        throw new Error(error.message);
      }
      const url = URL.createObjectURL(avatar);
      data.avatar_url = url;
    }
    return data;
  };

  const update = async (updates: any) => {
    let avatar_url = updates.avatar_url;
    if (typeof updates.avatar_url !== "string" && updates.avatar_url) {
      // Upload into a per-user FOLDER, not the bucket root. The storage policies
      // are owner-scoped on `(storage.foldername(name))[1]`, which is only a
      // meaningful check when the object actually sits under a folder — a
      // root-level `${user.id}.${ext}` has no folder segment at all. Bare
      // extension, no original filename: the name is caller-supplied and
      // nothing downstream needs it.
      const ext = String(updates.avatar_url.name).split(".").pop()?.toLowerCase();
      const safeExt = /^[a-z0-9]{1,5}$/.test(ext ?? "") ? ext : "img";
      const filepath = `${user?.id}/avatar.${safeExt}`;
      const { error } = await supabase.storage
        .from("avatar")
        .upload(filepath, updates.avatar_url, {
          upsert: true,
        });
      if (error) {
        throw new Error(error.message);
      }
      avatar_url = filepath;
    }

    const { error, data } = await supabase
      .from("profile")
      .update({ ...updates, avatar_url })
      .eq("id", user?.id);
    if (error) {
      throw new Error(error.message);
    }
    return data;
  };

  const getProfile = async () => {
    const data = await getSingle();
    setProfile(data);
  };

  const updateProfile = async (updates: any) => {
    const data = await update(updates);
    await supabase.auth.updateUser({
      data: { ...(user?.user_metadata || {}), display_name: updates?.name },
    });
    return data;
  };

  useEffect(() => {
    if (user?.id) {
      getProfile();
    }
  }, [user?.id]);

  return {
    profile,
    getProfile,
    updateProfile,
  };
};
