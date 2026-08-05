import { getAppIdByName } from "@/utils/get-app-id";
import { loadDashboardsForApp, loadTemplates } from "@/features/dashboards/read";
import { DashboardList } from "@/features/dashboards/components/dashboard-list";
import type { DashboardSummary, DashboardTemplate } from "@/features/dashboards/types";

export const dynamic = "force-dynamic";

export default async function DashboardsPage({
  params,
}: {
  params: Promise<{ appName: string }>;
}) {
  const { appName } = await params;
  const appId = await getAppIdByName(appName);

  // An empty list here means "no dashboards yet" and drives a cold-start
  // gallery inviting the user to create their first one. A failed read must
  // therefore never reduce to an empty list: it would tell the user their
  // dashboards are gone. The failure carries as its own flag instead.
  //
  // The flag is fixed copy, never the caught error's message: service errors
  // wrap PostgREST/Postgres text verbatim (relation names, query fragments,
  // connection targets), and threading a thrown server error into props routes
  // around the framework's own production redaction. The detail belongs in the
  // server log, which is why the catch still logs.
  let initialDashboards: DashboardSummary[] = [];
  let initialTemplates: DashboardTemplate[] = [];
  let loadError: string | null = null;
  if (appId) {
    try {
      [initialDashboards, initialTemplates] = await Promise.all([
        loadDashboardsForApp(appId),
        loadTemplates(),
      ]);
    } catch (err) {
      console.error("[dashboards] list read failed:", err);
      loadError = "The dashboard list couldn't be read just now. Nothing was lost — try again.";
    }
  }

  return (
    <DashboardList
      appId={appId ?? ""}
      initialDashboards={initialDashboards}
      initialTemplates={initialTemplates}
      loadError={loadError}
    />
  );
}
