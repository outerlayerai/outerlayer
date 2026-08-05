import { getAppIdByName } from "@/utils/get-app-id";
import { loadDashboardForApp, loadDashboardsForApp } from "@/features/dashboards/read";
import { DashboardView } from "@/features/dashboards/components/dashboard-view";
import type { Dashboard, DashboardSummary } from "@/features/dashboards/types";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ appName: string; dashboardId: string }>;
}) {
  const { appName, dashboardId } = await params;
  const appId = await getAppIdByName(appName);

  let initialDashboard: Dashboard | null = null;
  // The dashboard-switcher menu inside the detail view lists every dashboard
  // for the app; seeding it here means it never depends on the (now-deleted)
  // list GET route either.
  let initialDashboards: DashboardSummary[] = [];
  // A failure FLAG rides to the view: a null dashboard from a FAILED read is a
  // different state from a null dashboard the read genuinely resolved, and only
  // the second one means the dashboard is gone. Fixed copy, not the caught
  // error's message — those wrap Postgres text verbatim, and the detail belongs
  // in the server log below rather than on a tenant's screen.
  let loadError: string | null = null;
  if (appId) {
    try {
      [initialDashboard, initialDashboards] = await Promise.all([
        loadDashboardForApp(appId, dashboardId),
        loadDashboardsForApp(appId),
      ]);
    } catch (err) {
      console.error("[dashboards] detail read failed:", err);
      loadError = "Couldn't load this dashboard.";
    }
  }

  return (
    <DashboardView
      dashboardId={dashboardId}
      appId={appId ?? ""}
      initialDashboard={initialDashboard}
      initialDashboards={initialDashboards}
      loadError={loadError}
    />
  );
}
