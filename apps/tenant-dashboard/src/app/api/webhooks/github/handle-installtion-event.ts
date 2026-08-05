import { revalidatePath } from "next/cache";
import { createSupabaseAdminClient } from "../../../../supabaseAdminClient";
import { paths } from "../../../../routes/paths";

export const handleInstallationEvent = async (eventData: any) => {
  const supabaseAdmin = createSupabaseAdminClient();

  if (eventData.repositories_removed.length > 0) {
    const repoNames = eventData.repositories_removed.map(
      (repo: any) => repo.full_name
    );
    const { data } = await supabaseAdmin
      .from("git_connection")
      .select("*")
      .in("repository", repoNames);

    await supabaseAdmin
      .from("git_connection")
      .delete()
      .in("repository", repoNames);

    if (data) {
      for (const d of data) {
        revalidatePath(paths.orgs.org.apps.root(d.tenant_id));
      }
    }
  }
};
