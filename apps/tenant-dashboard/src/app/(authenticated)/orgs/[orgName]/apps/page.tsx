import { AppLayout } from "../../../../../layouts/app/app-layout";
import { AppList } from "@/features/apps";
import { loadAppsList } from "@/features/apps/read";

export const metadata = {
  title: "Apps",
};

/**
 * Tenant-scoped and auth-gated: a shared revalidate window here would be a
 * cache-safety burden with no demonstrated need, so this page renders fresh
 * on every request rather than relying on ISR keying across tenants.
 */
export const dynamic = "force-dynamic";

export default async function OverviewAppPage() {
  const apps = await loadAppsList();

  return (
    <AppLayout>
      <AppList apps={apps} />
    </AppLayout>
  );
}
