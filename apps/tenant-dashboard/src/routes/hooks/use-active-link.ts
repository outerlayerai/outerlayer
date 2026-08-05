"use client";

import { useParams, usePathname } from "next/navigation";

// ----------------------------------------------------------------------

type ReturnType = boolean;

export function useActiveLink(path: string, _deep = true): ReturnType {
  const { orgName, appName } = useParams();

  const basePath = `/orgs/${orgName}/apps/${appName}`;

  path = path.replace(basePath, "") || "/";

  const pathname = usePathname().replace(basePath, "") || "/";

  if (pathname === path) {
    return true;
  }

  // The env overview ("/env/<env>") is the URL parent of every tab, so a
  // generic prefix match would mark Dashboard active on every route. It owns
  // only its own URL and the dashboards surface it redirects to (the env
  // index replaces itself with /dashboards/<default-id> once a trace exists).
  if (/^\/env\/[^/]+$/.test(path)) {
    return pathname === `${path}/dashboards` || pathname.startsWith(`${path}/dashboards/`);
  }

  // Child routes keep their tab highlighted (e.g. /templates/<name>), but a
  // tab never matches mid-path or a sibling sharing the same name prefix.
  return path !== "/" && pathname.startsWith(`${path}/`);
}
