// Import the concrete-only seam entry, NOT the `@/components/loading-screen`
// barrel: the barrel re-exports the client-only `splash-screen`, and pulling
// that into this server component's module graph breaks the production build.
import LoadingScreen from "@/components/loading-screen/loading-screen";

/**
 * Suspense fallback for tab navigations INSIDE an app.
 *
 * Without this boundary, switching tabs (traces → sessions → …) suspends all
 * the way up to `apps/loading.tsx`, whose fallback is the apps-LIST skeleton —
 * so every tab switch flashed what looked like the apps list page, unmounting
 * the whole app shell on the way. This boundary sits inside the `[appName]`
 * layout, so the dashboard chrome stays mounted and only the content area
 * shows a spinner while the next tab's payload streams in.
 */
export default function AppTabLoading() {
  return <LoadingScreen />;
}
