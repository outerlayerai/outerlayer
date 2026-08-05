// Import the concrete-only seam entry, NOT the `@/components/loading-screen`
// barrel: the barrel re-exports the client-only `splash-screen`, and pulling
// that into this server component's module graph breaks the production build.
import LoadingScreen from "@/components/loading-screen/loading-screen";
import { AppLayout } from "../../../../layouts/app/app-layout";

export default function OrgLoading() {
  // AppLayout's LayoutMain supplies the full-height flex column, so the shared
  // LoadingScreen centers itself with its in-frame contract (flexGrow + minHeight).
  return (
    <AppLayout>
      <LoadingScreen />
    </AppLayout>
  );
}
