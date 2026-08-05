import { createSupabaseFontendClient } from "../supabaseFrontendClient";

export const getAvatarUrl = async (avatar_url: string) => {
  const supabase = createSupabaseFontendClient();
  let url = avatar_url;
  if (url) {
    const { data, error } = await supabase.storage
      .from("avatar")
      .download(avatar_url);
    if (!error) {
      url = URL.createObjectURL(data);
    }
  }
  return url;
};