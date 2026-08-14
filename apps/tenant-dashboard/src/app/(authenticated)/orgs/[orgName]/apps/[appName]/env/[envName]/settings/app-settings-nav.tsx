"use client";

import { useParams, usePathname, useSearchParams } from "next/navigation";
import NextLink from "next/link";
import {
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import Iconify from "@/components/iconify";

import type { Permission } from "@/utils/permissions";

type NavItem = {
  label: string;
  path: string;
  icon: string;
  // Permissions that reveal this tab. A tab shows when the user holds ANY of
  // them; an empty list means the tab is always visible. Co-locating the gate
  // with the tab definition mirrors the main nav (config-navigation.tsx) and
  // keeps the layout from having to know each tab's permission.
  requiredPermissions: Permission[];
};

const NAV_ITEMS: NavItem[] = [
  { label: "General", path: "general", icon: "solar:settings-bold-duotone", requiredPermissions: [] },
  { label: "API Keys", path: "api-keys", icon: "solar:key-bold-duotone", requiredPermissions: ["api_key.read"] },
  // Connector grants are scoped to the signed-in user, not this app — the
  // tab lives here for discoverability next to API Keys (same settings
  // surface a developer already checks for programmatic access), always
  // visible since there's no app-scoped permission to gate a user-owned
  // resource on.
  { label: "Connected Apps", path: "grants", icon: "solar:link-bold-duotone", requiredPermissions: [] },
  { label: "Environment Variables", path: "env-vars", icon: "solar:lock-password-bold-duotone", requiredPermissions: ["env_var.read"] },
];

type Props = {
  orgName: string;
  appName: string;
  /** The current user's effective permission set for this app. */
  permissions: Permission[];
};

export function AppSettingsNav({ orgName, appName, permissions }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Env is a path segment — keep it in the tab base path so switching settings
  // sub-tabs stays scoped to the selected env.
  const { envName } = useParams<{ envName: string }>();
  const basePath = `/orgs/${orgName}/apps/${appName}/env/${envName}/settings`;
  const qs = searchParams.toString();

  const granted = new Set(permissions);
  const visibleItems = NAV_ITEMS.filter(
    (item) =>
      item.requiredPermissions.length === 0 ||
      item.requiredPermissions.some((p) => granted.has(p)),
  );

  return (
    <List
      disablePadding
      sx={{
        width: { xs: "100%", md: 200 },
        flexShrink: 0,
        borderRight: { md: "1px solid" },
        borderColor: { md: "divider" },
        pr: { md: 1 },
        mb: { xs: 2, md: 0 },
        position: { md: "sticky" },
        top: { md: 64 },
        alignSelf: { md: "flex-start" },
        display: { xs: "flex", md: "block" },
        flexDirection: { xs: "row", md: "column" },
        overflowX: { xs: "auto", md: "visible" },
      }}
    >
      {visibleItems.map((item) => {
        const targetPath = `${basePath}/${item.path}`;
        const href = qs ? `${targetPath}?${qs}` : targetPath;
        const isActive =
          pathname === targetPath ||
          (item.path === "general" &&
            (pathname === basePath || pathname === `${basePath}/`));

        return (
          <ListItemButton
            key={item.path}
            component={NextLink}
            href={href}
            selected={isActive}
            sx={{
              borderRadius: 1,
              mb: { xs: 0, md: 0.5 },
              mr: { xs: 0.5, md: 0 },
              minWidth: { xs: "auto", md: "unset" },
              px: { xs: 1.5, md: 1.5 },
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              <Iconify icon={item.icon} width={20} />
            </ListItemIcon>
            <ListItemText
              primary={item.label}
              slotProps={{
                primary: { variant: "body2", sx: { fontWeight: isActive ? 600 : 400 } }
              }}
            />
          </ListItemButton>
        );
      })}
    </List>
  );
}
