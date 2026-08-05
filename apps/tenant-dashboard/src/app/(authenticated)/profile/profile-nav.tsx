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
  href: string;
  icon: string;
};

const NAV_ITEMS: NavItem[] = [
  { label: "General", href: "/profile", icon: "solar:user-bold-duotone" },
  { label: "Connections", href: "/profile/connections", icon: "solar:link-bold-duotone" },
  { label: "Security", href: "/profile/security", icon: "solar:lock-keyhole-bold-duotone" },
];

export function ProfileNav() {
  const pathname = usePathname();

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
      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.href;

        return (
          <ListItemButton
            key={item.href}
            component={NextLink}
            href={item.href}
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
                primary: { variant: "body2", sx: { fontWeight: isActive ? 600 : 400 } },
              }}
            />
          </ListItemButton>
        );
      })}
    </List>
  );
}
