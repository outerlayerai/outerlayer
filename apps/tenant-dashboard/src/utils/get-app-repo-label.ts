import { createSupabaseServerClient } from "../supabaseServerClient";

/**
 * Resolves an app's linked repo label (`git_connection.repository`),
 * RLS-scoped to apps the current user can read. Falls back to a placeholder
 * when the app has no git connection (or the read fails) — the benchmarks
 * page is always scoped to a repo label, never a hard requirement.
 */
export async function getAppRepoLabel(appId: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("git_connection")
    .select("repository")
    .eq("app_id", appId)
    .limit(1)
    .maybeSingle();

  return data?.repository ?? "your linked repo";
}
