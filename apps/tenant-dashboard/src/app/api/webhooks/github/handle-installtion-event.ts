import { revalidatePath } from "next/cache";
import { createSupabaseAdminClient } from "../../../../supabaseAdminClient";
import { paths } from "../../../../routes/paths";

export const handleInstallationEvent = async (eventData: any) => {
  const supabaseAdmin = createSupabaseAdminClient();

  // The event describes ONE installation losing access. Scoping the cleanup
  // to it keeps a same-named repository connected through a different
  // installation (another tenant's — installation ids are tenant-exclusive,
  // see 22-git-connection.sql's exclusion constraint) out of the sweep.
  const installationId = eventData.installation?.id;
  if (installationId == null) return;

  if (eventData.repositories_removed.length > 0) {
    const repoNames = eventData.repositories_removed.map(
      (repo: any) => repo.full_name
    );
    const { data } = await supabaseAdmin
      .from("git_connection")
      .select("*")
      .eq("installation_id", installationId)
      .in("repository", repoNames);

    await supabaseAdmin
      .from("git_connection")
      .delete()
      .eq("installation_id", installationId)
      .in("repository", repoNames);

    if (data) {
      for (const d of data) {
        revalidatePath(paths.orgs.org.apps.root(d.tenant_id));
      }
    }
  }
};
