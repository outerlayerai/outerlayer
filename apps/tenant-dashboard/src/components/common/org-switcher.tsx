"use client";

import { useState, useCallback, useEffect, MouseEvent } from "react";
import { useRouter, useParams, usePathname } from "next/navigation";
import Box from "@mui/material/Box";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import ButtonBase from "@mui/material/ButtonBase";
import CircularProgress from "@mui/material/CircularProgress";
import Iconify from "@/components/iconify";
import { useTheme } from "@mui/material/styles";
import { useTranslate } from "@outerlayer/locales";
import { useMemberships } from "../../auth/hooks/use-memberships";
import { paths } from "../../routes/paths";
import { CreateOrgDialog } from "@/features/org-lifecycle";
import { setLastActiveOrgAction } from "@/features/org-lifecycle/action-adapters";

const getTranslationKey = (key: string) => `org.switcher.${key}`;

type OrgSwitcherProps = {
  showSeparator?: boolean;
};

/**
 * OrgSwitcher component - Breadcrumb style
 * Displays org name as first breadcrumb item with dropdown on click
 */
export default function OrgSwitcher({ showSeparator = false }: OrgSwitcherProps) {
  const theme = useTheme();
  const router = useRouter();
  const { orgName } = useParams();
  const pathname = usePathname();
  const { memberships, isAtOrgLimit } = useMemberships();
  const { t: translate } = useTranslate();
  const [isLoading, setIsLoading] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  const t = (key: string) => translate(getTranslationKey(key));

  const open = Boolean(anchorEl);
  const currentOrgName = Array.isArray(orgName) ? orgName[0] : orgName;

  // OrgSwitcher is mounted in persistent header chrome, outside TenantGuard's
  // children, so it survives every navigation `handleOrgSelect` triggers —
  // nothing unmounts it to reset `isLoading` for free. A successful
  // navigation (landing on the picked org, or any other navigation that
  // supersedes this one) changes the pathname, so that's the release valve
  // for the common case.
  useEffect(() => {
    setIsLoading(false);
  }, [pathname]);

  // `router.push` never fires `popstate` (it's a forward `pushState`), but a
  // Back/Forward press does. That covers the case a pathname effect can't:
  // if the user backs out before the destination ever renders, navigation
  // can settle back on the exact URL `isLoading` was set from, so `pathname`
  // never observably changes across renders and its effect never re-fires.
  // Any `popstate` means the browser's own history navigation resolved,
  // making a pending click-triggered spinner stale regardless of where it
  // lands.
  useEffect(() => {
    function handlePopState() {
      setIsLoading(false);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const handleOrgSelect = useCallback(
    async (selectedOrgName: string) => {
      handleClose();

      // Handle "Add Organization" option
      if (selectedOrgName === "__add_org__") {
        setIsCreateDialogOpen(true);
        return;
      }

      // Don't switch if selecting the current org
      if (selectedOrgName === currentOrgName) {
        return;
      }

      setIsLoading(true);

      // Fire-and-forget preference write: the navigation below is what scopes
      // the next request, so nothing here needs to be awaited before routing.
      // A failure only leaves the CLI's default org stale — log it and move on.
      const selected = memberships.find(
        (membership) => membership.tenant.organization_name === selectedOrgName
      );
      if (selected) {
        void setLastActiveOrgAction(selected.tenant_id)
          .then((result) => {
            if (result.error) {
              console.error("Failed to record last-active org:", result.error);
            }
          })
          .catch((error) => {
            console.error("Failed to record last-active org:", error);
          });
      }

      const newPath = paths.orgs.org.apps.root(selectedOrgName);
      router.push(newPath);
    },
    [currentOrgName, memberships, router]
  );

  // Display the org name (URL slug) in the breadcrumb
  const displayName = currentOrgName;

  return (
    <>
      {/* Breadcrumb-style org switcher */}
      <Box sx={{ display: "flex", alignItems: "center" }}>
        <ButtonBase
          onClick={handleClick}
          disabled={isLoading}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            height: 32,
            px: 1,
            borderRadius: "6px",
            transition: theme.transitions.create(["background-color"]),
            "&:hover": { bgcolor: "action.hover" },
            ...(open && { bgcolor: "background.neutral" }),
          }}
        >
          {isLoading ? (
            <CircularProgress size={14} sx={{ mr: 0.5 }} />
          ) : null}

          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
              color: "text.primary",
              maxWidth: { xs: 96, sm: 160, lg: 240 },
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayName}
          </Typography>

          <Iconify
            icon="mdi:chevron-down"
            width={16}
            sx={{
              color: "text.secondary",
              transition: theme.transitions.create("transform"),
              ...(open && { transform: "rotate(180deg)" }),
            }}
          />
        </ButtonBase>

        {/* Breadcrumb separator - only show if there's content after */}
        {showSeparator && (
          <Box
            component="span"
            aria-hidden
            sx={{
              mx: 0.75,
              color: "text.disabled",
              fontSize: "0.875rem",
              fontWeight: 400,
              lineHeight: 1,
            }}
          >
            /
          </Box>
        )}
      </Box>

      {/* Dropdown Menu */}
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        transformOrigin={{ horizontal: "left", vertical: "top" }}
        anchorOrigin={{ horizontal: "left", vertical: "bottom" }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.5,
              minWidth: 200,
              maxWidth: 280,
              maxHeight: 320,
            },
          },
        }}
      >
        {/* Section header */}
        <Typography
          variant="overline"
          sx={{
            px: 2,
            py: 1,
            display: "block",
            color: "text.secondary",
            fontSize: 11,
          }}
        >
          {t("switchOrganization")}
        </Typography>

        {/* Organization list */}
        {memberships.map((membership) => (
          <MenuItem
            key={membership.tenant_id}
            onClick={() => handleOrgSelect(membership.tenant.organization_name)}
            selected={membership.tenant.organization_name === currentOrgName}
            sx={{ py: 1, px: 2 }}
          >
            <ListItemText
              primary={membership.tenant.company_name || membership.tenant.organization_name}
              secondary={
                membership.tenant.company_name
                  ? membership.tenant.organization_name
                  : undefined
              }
              slotProps={{
                primary: {
                  variant: "body2",
                  noWrap: true,
                  sx: { fontWeight: 500 },
                },
                secondary: {
                  variant: "caption",
                  noWrap: true,
                  sx: { color: "text.disabled" },
                },
              }}
            />
            {membership.tenant.organization_name === currentOrgName && (
              <Iconify
                icon="eva:checkmark-fill"
                width={16}
                sx={{ color: "primary.main", ml: 1 }}
              />
            )}
          </MenuItem>
        ))}

        <Divider sx={{ my: 0.5 }} />

        {/* Add Organization */}
        <MenuItem
          onClick={() => handleOrgSelect("__add_org__")}
          disabled={isAtOrgLimit}
          sx={{ py: 1, px: 2 }}
        >
          <ListItemText
            primary={t("createOrganization")}
            secondary={isAtOrgLimit ? t("limitReached") : null}
            slotProps={{
              primary: {
                variant: "body2",
                sx: {
                  fontWeight: 500,
                  color: isAtOrgLimit ? "text.disabled" : "primary.main",
                },
              },
              secondary: {
                variant: "caption",
                color: "text.disabled",
              },
            }}
          />
        </MenuItem>

      </Menu>

      {/* Create Org Dialog */}
      <CreateOrgDialog
        open={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
      />
    </>
  );
}
