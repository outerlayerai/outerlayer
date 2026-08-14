const ROOTS = {
  AUTH: "/auth",
  DASHBOARD: "/orgs",
  ORG: "/orgs",
  SETTINGS: "/settings",
  API: "/api",
  PROFILE: "/profile",
  PLATFORM_ADMIN: "/platform-admin",
};

// ----------------------------------------------------------------------

export const paths = {
  dashboard: {
    root: ROOTS.DASHBOARD,
  },
  auth: {
    login: `${ROOTS.AUTH}/login`,
    verify: `${ROOTS.AUTH}/verify`,
    register: `${ROOTS.AUTH}/register`,
    newPassword: `${ROOTS.AUTH}/new-password`,
    forgotPassword: `${ROOTS.AUTH}/forgot-password`,
    linkExpired: `${ROOTS.AUTH}/link-expired`,
  },
  profile: {
    root: ROOTS.PROFILE,
  },
  platformAdmin: {
    root: ROOTS.PLATFORM_ADMIN,
    organizations: `${ROOTS.PLATFORM_ADMIN}/organizations`,
    organizationDetail: (id: string) => `${ROOTS.PLATFORM_ADMIN}/organizations/${id}`,
    users: `${ROOTS.PLATFORM_ADMIN}/users`,
    userDetail: (id: string) => `${ROOTS.PLATFORM_ADMIN}/users/${id}`,
    featureFlags: `${ROOTS.PLATFORM_ADMIN}/feature-flags`,
    tempAccess: `${ROOTS.PLATFORM_ADMIN}/temp-access`,
    auditLogs: `${ROOTS.PLATFORM_ADMIN}/audit-logs`,
  },
  orgs: {
    root: ROOTS.ORG,
    org: {
      root: (orgName: string) => `${ROOTS.ORG}/${orgName}`,
      apps: {
        root: (orgName: string) => `${ROOTS.ORG}/${orgName}/apps`,
        app: {
          root: (orgName: string, appName: string) =>
            `${ROOTS.ORG}/${orgName}/apps/${appName}`,
        },
      },
      settings: {
        root: (orgName: string) => `${ROOTS.ORG}/${orgName}/settings`,
      },
    },
  },
};

/**
 * App-scoped route builders. As of the env-routing migration, every tab lives
 * under an `/env/<envName>/` path segment, so each builder takes `envName`
 * after `appName` and emits `/orgs/<org>/apps/<app>/env/<env>/<tab>`.
 *
 * The one exception is {@link appPaths.context} — an app-level lifecycle
 * surface that intentionally has NO env segment.
 *
 * Sidebar nav items are an exception to passing `envName` here:
 * `config-navigation` has no env at build time, so it builds bare paths and
 * `useNavHref` injects the segment at render via `EnvContext.envPath`.
 */
const envBase = (orgName: string, appName: string, envName: string) =>
  `${ROOTS.ORG}/${orgName}/apps/${appName}/env/${envName}`;

/**
 * First path segment (after `/orgs/<org>/apps/<app>`) of app-level surfaces
 * that intentionally carry NO `/env/<name>/` segment — `appPaths.context` is
 * the one documented case today. `envPath` (`env-context.tsx`) consults this
 * set before injecting an env segment into a bare app path, so it never
 * rewrites one of these into a URL with no matching route.
 */
export const APP_LEVEL_SEGMENTS = new Set(["context"]);

export const appPaths = {
  // OuterLayer Context tab. App-level (NO env segment) — context hangs off the
  // repo, not an environment. Read-only tree + viewer.
  context: {
    root: (orgName: string, appName: string) =>
      `${ROOTS.ORG}/${orgName}/apps/${appName}/context`,
    /**
     * The Overview (the bare context route's default view), optionally with a
     * range and one open detail panel. `skill` and `server` are mutually
     * exclusive — one panel at a time — so `skill` wins when both are passed.
     */
    overview: (
      orgName: string,
      appName: string,
      opts?: { range?: string; skill?: string; server?: string },
    ) => {
      const params = new URLSearchParams();
      if (opts?.range) params.set("range", opts.range);
      if (opts?.skill) params.set("skill", opts.skill);
      else if (opts?.server) params.set("server", opts.server);
      const qs = params.toString();
      return `${ROOTS.ORG}/${orgName}/apps/${appName}/context${qs ? `?${qs}` : ""}`;
    },
  },
  // "developers" is the legacy name for the per-env Settings surface. `root`
  // is the settings index (redirects to General); the sub-page builders below
  // are the single source of truth for each settings tab's URL so callers
  // never hand-concatenate `${...settings}/api-keys` and drift.
  developers: {
    root: (orgName: string, appName: string, envName: string) =>
      `${envBase(orgName, appName, envName)}/settings`,
    general: (orgName: string, appName: string, envName: string) =>
      `${envBase(orgName, appName, envName)}/settings/general`,
    apiKeys: (orgName: string, appName: string, envName: string) =>
      `${envBase(orgName, appName, envName)}/settings/api-keys`,
    envVars: (orgName: string, appName: string, envName: string) =>
      `${envBase(orgName, appName, envName)}/settings/env-vars`,
  },
  insights: {
    // The trace-topics surface; URL + label say Insights.
    root: (orgName: string, appName: string, envName: string) =>
      `${envBase(orgName, appName, envName)}/insights`,
  },
  workers: {
    root: (orgName: string, appName: string, envName: string) =>
      `${envBase(orgName, appName, envName)}/workers`,
  },
  dashboards: {
    root: (orgName: string, appName: string, envName: string) =>
      `${envBase(orgName, appName, envName)}/dashboards`,
    view: (orgName: string, appName: string, envName: string, dashboardId: string) =>
      `${envBase(orgName, appName, envName)}/dashboards/${dashboardId}`,
  },
  agents: {
    sessions: (orgName: string, appName: string, envName: string) =>
      `${envBase(orgName, appName, envName)}/agents/sessions`,
    session: (orgName: string, appName: string, envName: string, traceId: string) =>
      `${envBase(orgName, appName, envName)}/agents/sessions/${traceId}`,
    artifact: (orgName: string, appName: string, envName: string, artifactId: string) =>
      `${envBase(orgName, appName, envName)}/agents/artifacts/${artifactId}`,
  },
};
