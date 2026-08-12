"use client";

import { usePathname } from "next/navigation";
import NextLink from "next/link";
import {
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import Iconify from "@/components/iconify";

type NavItem = {
  label: string;
  path: string;
  icon: string;
};

const GENERAL_NAV_ITEM: NavItem = { label: "General", path: "general", icon: "solar:buildings-2-bold-duotone" };
const MEMBERS_NAV_ITEM: NavItem = { label: "Members", path: "members", icon: "solar:users-group-rounded-bold-duotone" };

const BILLING_NAV_ITEM: NavItem = {
  label: "Billing",
  path: "billing",
  icon: "solar:card-bold-duotone",
};

const AI_COSTS_NAV_ITEM: NavItem = {
  label: "AI costs",
  path: "ai-costs",
  icon: "solar:dollar-minimalistic-bold-duotone",
};

const ROLES_NAV_ITEM: NavItem = {
  label: "Roles",
  path: "roles",
  icon: "solar:user-id-bold-duotone",
};

const SSO_NAV_ITEM: NavItem = {
  label: "SSO",
  path: "sso",
  icon: "solar:shield-keyhole-bold-duotone",
};

const AUDIT_LOG_NAV_ITEM: NavItem = {
  label: "Audit log",
  path: "audit-log",
  icon: "solar:history-bold-duotone",
};

const LICENSE_NAV_ITEM: NavItem = {
  label: "License",
  path: "license",
  icon: "solar:key-bold-duotone",
};

const ADMIN_API_KEYS_NAV_ITEM: NavItem = {
  label: "Admin API keys",
  path: "admin-api-keys",
  icon: "solar:key-minimalistic-square-bold-duotone",
};

type Props = {
  orgName: string;
  showRolesTab: boolean;
  showSsoTab: boolean;
  showBillingTab: boolean;
  showAuditLogTab: boolean;
  showLicenseTab: boolean;
  showAiCostsTab: boolean;
  showAdminApiKeysTab: boolean;
};

export function SettingsNav({
  orgName,
  showRolesTab,
  showSsoTab,
  showBillingTab,
  showAuditLogTab,
  showLicenseTab,
  showAiCostsTab,
  showAdminApiKeysTab,
}: Props) {
  const pathname = usePathname();
  const navItems = [
    GENERAL_NAV_ITEM,
    ...(showBillingTab ? [BILLING_NAV_ITEM] : []),
    // Org-wide AI program costs (seats × $/seat/mo) feeding "Total Cost of
    // AI" — gated on ai_cost_config.read (owner/admin), like the audit log.
    ...(showAiCostsTab ? [AI_COSTS_NAV_ITEM] : []),
    MEMBERS_NAV_ITEM,
    ...(showRolesTab ? [ROLES_NAV_ITEM] : []),
    ...(showSsoTab ? [SSO_NAV_ITEM] : []),
    ...(showAuditLogTab ? [AUDIT_LOG_NAV_ITEM] : []),
    ...(showAdminApiKeysTab ? [ADMIN_API_KEYS_NAV_ITEM] : []),
    // Self-host only — the licensed-org surface. Cloud never sets the flag.
    ...(showLicenseTab ? [LICENSE_NAV_ITEM] : []),
  ];

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
      {navItems.map((item) => {
        const href = `/orgs/${orgName}/settings/${item.path}`;
        const isActive =
          pathname === href ||
          (item.path === "general" &&
            (pathname === `/orgs/${orgName}/settings` ||
              pathname === `/orgs/${orgName}/settings/`));

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
