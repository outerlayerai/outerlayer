import { getAppRoleAssignments } from "@/utils/get-app-permissions";
import { AppPermissionsProvider } from "@/auth/context/app-permissions-context";
import { TenantGuard } from "../../../../auth/guard";

type Props = {
  children: React.ReactNode;
};

/**
 * Server half of the org layout.
 *
 * Seeds the user's per-app role assignments AND their org-level role ONCE,
 * org-wide (`appRoles`/`role` are user-global, not keyed by app — see
 * `AppPermissionsProvider`), so org-level consumers like the apps-list page
 * (`sections/apps/app-list.tsx`'s `useAppRoles()`) and `useCurrentUser`
 * resolve synchronously from the snapshot instead of self-fetching or
 * trusting the JWT claim (which can name a different org for a multi-org
 * user). The `[appName]` layout, further down, mounts its OWN nested
 * `AppPermissionsProvider` with the app-scoped permission set (and its own
 * `role` seed) — that nested provider shadows this one for anything under an
 * app, so this seed only matters for org-level routes outside `[appName]`.
 *
 * `TenantGuard` is preserved as the exact same client child: this seed adds a
 * provider ABOVE it and does not touch, reorder, or weaken its gate — the
 * membership/tenant-sync checks run exactly as before.
 */
export default async function Layout({ children }: Props) {
  const roleAssignments = await getAppRoleAssignments();

  return (
    <AppPermissionsProvider
      appId={null}
      permissions={[]}
      appRoles={roleAssignments?.appRoles}
      isAppScoped={roleAssignments?.isAppScoped}
      role={roleAssignments?.role}
    >
      <TenantGuard>{children}</TenantGuard>
    </AppPermissionsProvider>
  );
}
