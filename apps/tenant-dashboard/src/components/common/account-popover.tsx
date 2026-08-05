import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Avatar from "@mui/material/Avatar";
import Divider from "@mui/material/Divider";
import MenuItem from "@mui/material/MenuItem";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { Theme } from "@mui/material/styles";

import { paths } from "../../routes/paths";
import { useRouter } from "../../routes/hooks";

import { useAuthContext } from "../../auth/hooks";
import { usePlatformAdmin } from "../../auth/hooks/use-platform-admin";

import { useSnackbar } from '@/components/snackbar';
import CustomPopover, { usePopover } from '@/components/custom-popover';
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslate } from "@outerlayer/locales";
import { getAvatarUrl } from "../../utils/storage";
import { Profile } from "../../types/profile";
import { createSupabaseFontendClient } from "../../supabaseFrontendClient";
import Iconify from "@/components/iconify";
import { POPOVER } from "../../layouts/config-layout";

// Shared menu-item anatomy for the account popover: 36px rows, 6px
// radius, medium weight, body2 type. The row height is pinned at the sm
// breakpoint too, otherwise MUI's own `min-height: auto` at sm wins over a plain
// `minHeight` and the rows collapse to their padding height.
const menuItemSx = (theme: Theme) => ({
  minHeight: 36,
  [theme.breakpoints.up("sm")]: { minHeight: 36 },
  borderRadius: "6px",
  px: 1.25,
  typography: "body2",
  fontWeight: 500,
});

// ----------------------------------------------------------------------

// Module-level profile cache keyed by user id. AppLayout (and this header)
// remounts on every org-level navigation; without a cache the avatar refetches
// and blinks blank→filled each time — the visible header flash. The cache lets
// a remount paint the avatar synchronously from the last known profile and skip
// the refetch; realtime UPDATEs below keep it fresh.
let cachedProfile: Profile | null = null;
let cachedProfileUserId: string | null = null;

export default function AccountPopover() {
  const router = useRouter();

  const { user } = useAuthContext();
  const { isPlatformAdmin } = usePlatformAdmin();

  const [profile, setProfile] = useState<Profile | null | undefined>(() =>
    user?.id && cachedProfileUserId === user.id ? cachedProfile : undefined,
  );

  const supabase = createSupabaseFontendClient();

  // The frontend Supabase client is a process-wide singleton and realtime-js
  // (>=2.11.10) dedupes channels by topic, so a fixed channel name shared by two
  // co-mounted instances (both header layouts render this popover) collapses to
  // one already-subscribed channel and `.subscribe()` throws "tried to subscribe
  // multiple times". A per-instance topic keeps each mount on its own channel.
  const channelTopic = `profile-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const realtimeProfile = () => {
    return supabase
      .channel(channelTopic)
      .on<Profile>(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "profile",
          filter: `id=eq.${user?.id}`,
        },
        async (payload) => {
          const { new: newProfile } = payload;
          const url = await getAvatarUrl(newProfile.avatar_url!);
          const merged = { ...newProfile, avatar_url: url! };
          cachedProfile = merged;
          cachedProfileUserId = user?.id ?? null;
          setProfile(merged);
        }
      )
      .subscribe();
  };

  const getInitialProfileState = async () => {
    const { data } = await supabase
      .from("profile")
      .select("*")
      .eq("id", user?.id)
      .single();
    const url = await getAvatarUrl(data?.avatar_url!);
    const newProfile = { ...data, avatar_url: url! } as Profile;
    cachedProfile = newProfile;
    cachedProfileUserId = user?.id ?? null;
    setProfile(newProfile);
  };

  const { logout } = useAuthContext();

  const { enqueueSnackbar } = useSnackbar();
  const { t } = useTranslate();
  const popover = usePopover();

  const OPTIONS = useMemo(() => {
    return [
      {
        label: t("dashboard.headerAccountPopup.profileMenuItem"),
        linkTo: paths.profile.root,
      },
    ];
  }, [t]);

  const handleLogout = async () => {
    try {
      await logout();
      popover.onClose();
      router.replace("/auth/login");
    } catch (error) {
      console.error(error);
      enqueueSnackbar("Unable to logout!", { variant: "error" });
    }
  };

  const handleClickItem = (path: string) => {
    popover.onClose();
    router.push(path);
  };

  useEffect(() => {
    if (user?.id) {
      // Cache hit (a remount): paint from cache, skip the refetch that made the
      // avatar blink. Cache miss (first mount / user change): fetch once.
      if (cachedProfileUserId === user.id && cachedProfile) {
        setProfile(cachedProfile);
      } else {
        getInitialProfileState();
      }
      const channel = realtimeProfile();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [user?.id]);

  return (
    <>
      <ButtonBase
        onClick={popover.onOpen}
        aria-label="account"
        sx={{ width: 36, height: 36, borderRadius: "50%", flexShrink: 0 }}
      >
        <Avatar
          src={profile?.avatar_url!}
          alt={profile?.name!}
          sx={(theme) => ({
            width: 32,
            height: 32,
            fontSize: "0.875rem",
            fontWeight: 600,
            bgcolor: (theme.vars ?? theme).palette.background.neutral,
            color: (theme.vars ?? theme).palette.text.secondary,
            border: "1px solid",
            // Border-step states, no fill change and no hover-scale motion.
            // Hover must not fire while the popover is open, so gate it on the
            // closed state.
            ...(popover.open
              ? { borderColor: (theme.vars ?? theme).palette.primary.main }
              : {
                  borderColor: (theme.vars ?? theme).palette.divider,
                  "&:hover": {
                    borderColor: (theme.vars ?? theme).palette.text.disabled,
                  },
                }),
          })}
        >
          {profile?.name?.charAt(0).toUpperCase()}
        </Avatar>
      </ButtonBase>

      <CustomPopover
        open={popover.open}
        onClose={popover.onClose}
        hiddenArrow
        sx={{ width: POPOVER.ACCOUNT_WIDTH, p: 0 }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" noWrap>
            {profile?.name}
          </Typography>

          <Typography variant="body2" sx={{ color: "text.secondary" }} noWrap>
            {profile?.email}
          </Typography>
        </Box>

        <Divider />

        <Stack sx={{ p: 0.75 }}>
          {OPTIONS.map((option) => (
            <MenuItem
              key={option.label}
              onClick={() => handleClickItem(option.linkTo)}
              sx={menuItemSx}
            >
              <Iconify
                icon="mdi:account-outline"
                width={18}
                sx={{ mr: 1.5, color: "text.secondary" }}
              />
              {option.label}
            </MenuItem>
          ))}

          {/* Organization settings — gated to admin/owner. This is the app's
              only persistent path to org settings. */}
          {(user?.role === "admin" || user?.role === "owner") && (
            <MenuItem
              onClick={() =>
                handleClickItem(
                  paths.orgs.org.settings.root(
                    // activeTenant, not tenant: it re-derives from the URL
                    // on every render, while tenant only refreshes on auth
                    // events and would still name the previous org right
                    // after a switch.
                    user?.activeTenant?.organization_name as string,
                  ),
                )
              }
              sx={menuItemSx}
            >
              <Iconify
                icon="mdi:cog-outline"
                width={18}
                sx={{ mr: 1.5, color: "text.secondary" }}
              />
              Organization settings
            </MenuItem>
          )}
        </Stack>

        {isPlatformAdmin && (
          <>
            <Divider />
            <Stack sx={{ p: 0.75 }}>
              <MenuItem
                onClick={() => handleClickItem(paths.platformAdmin.root)}
                sx={menuItemSx}
              >
                <Iconify
                  icon="mdi:shield-outline"
                  width={18}
                  sx={{ mr: 1.5, color: "text.secondary" }}
                />
                Platform Admin
              </MenuItem>
            </Stack>
          </>
        )}

        <Divider />

        <Stack sx={{ p: 0.75 }}>
          <MenuItem
            onClick={handleLogout}
            sx={[
              menuItemSx,
              {
                color: "error.main",
                "&:hover": { bgcolor: "error.lighter" },
              },
            ]}
          >
            <Iconify
              icon="mdi:logout"
              width={18}
              sx={{ mr: 1.5, color: "error.main" }}
            />
            Logout
          </MenuItem>
        </Stack>
      </CustomPopover>
    </>
  );
}
