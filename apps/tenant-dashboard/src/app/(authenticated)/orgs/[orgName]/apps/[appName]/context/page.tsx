import { notFound } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppIdByName } from "@/utils/get-app-id";
import { loadRequestServiceContext } from "@/lib/adapters";
import { load, getOverviewFromTree } from "@/features/context/service";
import { ContextView } from "@/features/context/components/context-view";
import type { ContextOverviewRange } from "@/features/context/types";
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

const OVERVIEW_RANGES: ReadonlySet<string> = new Set(["24h", "7d", "30d", "90d"]);

/**
 * Server half of the context surface. Resolves the app under the URL org's
 * tenant and seeds the client editor's first paint (tree + skill/MCP overlays +
 * the `?file=`-selected file, plus the Overview payload when the URL resolves
 * to the Overview view) through the feature service — no client fetch on
 * mount and no UI-serving API route. The editor stays a client subsystem; only
 * the read origin lives here.
 */
export default async function ContextPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgName: string; appName: string }>;
  searchParams: Promise<{
    file?: string;
    view?: string;
    range?: string;
    skill?: string;
    server?: string;
  }>;
}) {
  const { appName } = await params;
  const { file, view, range } = await searchParams;

  const appId = await getAppIdByName(appName);
  if (!appId) notFound();

  const ctx = await loadRequestServiceContext();
  const seed = await load(ctx.db as SupabaseClient<Database>, appId, file ?? null);

  // Mirror the client's view resolution: an explicit `view` wins; a bare URL
  // carrying `file=` is a pre-Overview Files link; otherwise Overview.
  const resolvedView =
    view === "history" || view === "files"
      ? view
      : view === "overview"
        ? "overview"
        : file
          ? "files"
          : "overview";
  const overviewRange: ContextOverviewRange = OVERVIEW_RANGES.has(range ?? "")
    ? (range as ContextOverviewRange)
    : "30d";
  const overview =
    resolvedView === "overview"
      ? await getOverviewFromTree(seed.tree, { tenantId: ctx.tenantId, appId }, overviewRange)
      : null;

  return (
    <ContextView
      appId={appId}
      initialTree={seed.tree}
      initialFile={seed.file}
      initialSelectedPath={file ?? null}
      initialOverview={overview}
    />
  );
}
