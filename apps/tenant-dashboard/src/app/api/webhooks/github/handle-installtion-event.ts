import { revalidatePath } from "next/cache";
import { createSupabaseAdminClient } from "../../../../supabaseAdminClient";
import { paths } from "../../../../routes/paths";

export const handleInstallationEvent = async (eventData: any) => {
  const supabaseAdmin = createSupabaseAdminClient();

  // The event describes ONE installation losing access. Scoping the cleanup
  // to it keeps a same-named repository connected through a different
  // installation (another tenant's — installation ids are tenant-exclusive,
  // see 22-git-connection.sql's exclusion constraint) out of the sweep.
  // Rows with a NULL installation_id predate that bookkeeping and can only
  // be matched by repository name, so they stay in scope.
  const installationId = eventData.installation?.id;
  if (installationId == null) return;

  if (eventData.repositories_removed.length > 0) {
    const repoNames = eventData.repositories_removed.map(
      (repo: any) => repo.full_name
    );
    const installationScope = `installation_id.eq.${installationId},installation_id.is.null`;
    const { data } = await supabaseAdmin
      .from("git_connection")
      .select("*")
      .in("repository", repoNames)
      .or(installationScope);

    await supabaseAdmin
      .from("git_connection")
      .delete()
      .in("repository", repoNames)
      .or(installationScope);

    if (data && data.length > 0) {
      // The apps route is keyed by ORGANIZATION NAME, not tenant id — a
      // tenant-id path matches no cached route and revalidates nothing.
      const tenantIds = [...new Set(data.map((d) => d.tenant_id as string))];
      const { data: tenants } = await supabaseAdmin
        .from("tenant")
        .select("tenant_id, organization_name")
        .in("tenant_id", tenantIds);
      for (const t of tenants ?? []) {
        revalidatePath(paths.orgs.org.apps.root(t.organization_name));
      }
    }
  }
};
