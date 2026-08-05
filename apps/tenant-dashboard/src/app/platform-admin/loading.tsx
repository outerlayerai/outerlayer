// Import the concrete-only seam entry, NOT the `@/components/loading-screen`
// barrel: the barrel re-exports the client-only `splash-screen`, and pulling
// that into this server component's module graph breaks the production build.
import LoadingScreen from "@/components/loading-screen/loading-screen";

export default function PlatformAdminLoading() {
  // No layout flex chain wraps this route's fallback, so give the loader an
  // explicit viewport height to center within rather than pinning it to the top.
  return <LoadingScreen sx={{ minHeight: "100vh" }} />;
}
