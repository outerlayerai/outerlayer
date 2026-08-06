import { useTranslate } from "@outerlayer/locales";
import { appPaths } from "../../routes/paths";
import { useOptionalEnvContext, DEFAULT_ENV_NAME } from "../../context/env-context";
import Iconify from "@/components/iconify";
import { useParams } from "next/navigation";
import { useAuthContext } from "../../auth/hooks";
import { useAppContext } from "@/lib/app-shell/app-context/use-app-context";
import { useAppPermissions } from "../../auth/hooks/use-app-permissions";

const iconfiy = (name: string) => (
  <Iconify icon={name} sx={{ width: 1, height: 1 }} />
);

const ICONS = {
  settings: iconfiy("material-symbols:settings-outline"),
  agentSessions: iconfiy("fluent:group-list-24-regular"),
  topics: iconfiy("fluent:tag-multiple-24-regular"),
  dashboards: iconfiy("material-symbols:dashboard-outline-rounded"),
  fleet: iconfiy("mdi:robot-outline"),
  context: iconfiy("mdi:brain"),
};

// ----------------------------------------------------------------------

type NavItem = {
  title: string;
  path: string;
  icon: React.ReactElement;
  info?: React.ReactElement;
};

type NavItemWithPermission = NavItem & { requiredPermission: string };

export function useNavData() {
  const params: { orgName: string; appName: string } = useParams();

  const { t } = useTranslate();
  const { user } = useAuthContext();
  const { app } = useAppContext();

  // Env path segment for the sidebar links. `useNavData` runs under
  // `EnvProvider` for app routes, so the selection is available; fall back to
  // the default env name when it isn't (org-level shells). `useNavHref` would
  // also inject the segment, but building it here keeps the active-state match
  // exact and makes the env explicit at the source.
  const envName =
    useOptionalEnvContext()?.selectedEnv.name ?? DEFAULT_ENV_NAME;

  // When inside an app context, use per-app permissions (mirrors app_authorize() priority chain).
  // Falls back to org-level permissions for unrestricted users (is_app_scoped=false).
  const { permissions: appPermissions, isLoading: appPermsLoading } = useAppPermissions(app?.id ?? null);

  // When there's no app context, or while app-level permissions are loading,
  // fall back to org-level permissions so nav doesn't flicker hidden.
  const effectivePermissions = (!app?.id || appPermsLoading)
    ? (user?.permissions ?? [])
    : appPermissions;

  const hasPermission = (perm: string) =>
    effectivePermissions.some((p) => p.permission === perm);

  const allItems: NavItemWithPermission[] = [
    {
      title: t("dashboard.sidebar.dashboards"),
      path: appPaths.dashboards.root(params.orgName, params.appName, envName),
      icon: ICONS.dashboards,
      requiredPermission: "dashboard.read",
    },
    {
      // App-level (NO env segment) — context hangs off the repo, not an env.
      // `useNavHref` leaves APP_LEVEL_SEGMENTS paths (see paths.ts) alone.
      title: "Context",
      path: appPaths.context.root(params.orgName, params.appName),
      icon: ICONS.context,
      requiredPermission: "context.read",
    },
    {
      title: "Workers",
      path: appPaths.workers.root(params.orgName, params.appName, envName),
      icon: ICONS.fleet,
      requiredPermission: "worker_run.read",
    },
    {
      title: "Sessions",
      path: appPaths.agents.sessions(params.orgName, params.appName, envName),
      icon: ICONS.agentSessions,
      requiredPermission: "trace.read",
    },
    {
      title: t("dashboard.sidebar.topics"),
      path: appPaths.insights.root(params.orgName, params.appName, envName),
      icon: ICONS.topics,
      requiredPermission: "trace.read",
    },
    {
      title: t("dashboard.sidebar.settings"),
      path: appPaths.developers.root(params.orgName, params.appName, envName),
      icon: ICONS.settings,
      requiredPermission: "app.read",
    },
  ];

  const items: NavItem[] = allItems
    .filter(({ requiredPermission }) => hasPermission(requiredPermission))
    .map(({ requiredPermission: _perm, ...item }) => item);

  return [
    {
      items,
    },
  ];
}
