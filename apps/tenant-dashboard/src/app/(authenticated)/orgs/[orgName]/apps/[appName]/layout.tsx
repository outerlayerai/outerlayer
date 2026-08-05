import { getAppIdByName } from "@/utils/get-app-id";
import { getAppByName } from "@/utils/get-app-by-name";
import { listOrgApps } from "@/utils/list-org-apps";
import { getAppPermissionSet, getAppRoleAssignments } from "@/utils/get-app-permissions";
import { AppPermissionsProvider } from "@/auth/context/app-permissions-context";
import { AppSeeder } from "@/lib/app-shell/app-context";
import { AppLayoutShell } from "./app-layout-shell";

type Props = {
  children: React.ReactNode;
  params: Promise<{ orgName: string; appName: string }>;
};

/**
 * Server half of the `[appName]` layout.
 *
 * Resolves the user's effective app permission set ONCE, server-side, and
 * hands it to `AppPermissionsProvider`. Because this layout persists across
 * tab navigations inside an app, every `PermissionGuard` / `useAppPermissions`
 * consumer below resolves synchronously from the snapshot — no per-tab-switch
 * `get_current_user_app_permissions` RPC, no blank frame while it loads.
 *
 * Also resolves the app row itself (`getAppByName`) and the org's app list
 * (`listOrgApps`), handing both to `<AppSeeder>`, which pushes them up into
 * the `AppProvider`/`AppListProvider` mounted above at `(authenticated)` —
 * neither provider opens a Supabase client of its own.
 */
export default async function Layout({ children, params }: Props) {
  const { appName } = await params;

  // RLS scopes the lookup to apps the user can read (same pattern as the
  // settings layout). A miss just means no snapshot — the client guards
  // (AppGuard / PermissionGuard) handle forbidden/not-found as before.
  const [appId, app, apps] = await Promise.all([
    getAppIdByName(appName),
    getAppByName(appName),
    listOrgApps(),
  ]);

  if (!appId) {
    return (
      <AppSeeder app={app} apps={apps}>
        <AppLayoutShell>{children}</AppLayoutShell>
      </AppSeeder>
    );
  }

  const [perms, roleAssignments] = await Promise.all([
    getAppPermissionSet(appId),
    getAppRoleAssignments(),
  ]);

  return (
    <AppSeeder app={app} apps={apps}>
      <AppPermissionsProvider
        appId={appId}
        permissions={Array.from(perms)}
        appRoles={roleAssignments?.appRoles}
        isAppScoped={roleAssignments?.isAppScoped}
        role={roleAssignments?.role}
      >
        <AppLayoutShell>{children}</AppLayoutShell>
      </AppPermissionsProvider>
    </AppSeeder>
  );
}
