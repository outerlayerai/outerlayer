import { notFound } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppIdByName } from "@/utils/get-app-id";
import { loadRequestServiceContext } from "@/lib/adapters";
import { load } from "@/features/context/service";
import { ContextView } from "@/features/context/components/context-view";
import type { Database } from "@/types/db";

export const metadata = {
  title: "Context",
};

// A Server Action posted against this route inherits this segment's
// `maxDuration` — `commitContextChangesAction`'s batch commit is the one that
// needs it. Bounded blob creation and a single tree listing (rather than
// per-file git calls) keep a publish to a handful of API round trips; 120s is
// headroom for the non-fast-forward retry loop, not a crutch for unbounded work.
export const maxDuration = 120;

/**
 * Server half of the context surface. Resolves the app under the URL org's
 * tenant and seeds the client editor's first paint (tree + skill/MCP overlays +
 * the `?file=`-selected file) through the feature service — no client fetch on
 * mount and no UI-serving API route. The editor stays a client subsystem; only
 * the read origin lives here.
 */
export default async function ContextPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgName: string; appName: string }>;
  searchParams: Promise<{ file?: string }>;
}) {
  const { appName } = await params;
  const { file } = await searchParams;

  const appId = await getAppIdByName(appName);
  if (!appId) notFound();

  const ctx = await loadRequestServiceContext();
  const seed = await load(
    ctx.db as SupabaseClient<Database>,
    ctx.tenantId,
    appId,
    file ?? null,
  );

  return (
    <ContextView
      appId={appId}
      initialTree={seed.tree}
      initialFile={seed.file}
      initialSkillAdoption={seed.skillAdoption}
      initialMcpAdoption={seed.mcpAdoption}
      initialSelectedPath={file ?? null}
    />
  );
}
