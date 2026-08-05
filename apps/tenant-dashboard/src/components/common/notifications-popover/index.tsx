import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Iconify from "@/components/iconify";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useId, useState } from "react";
import { createSupabaseFontendClient } from "../../../supabaseFrontendClient";
import { useAuthContext } from "../../../auth/hooks";
import { Notification } from "../../../types/notification";
import { Drawer, List } from "@mui/material";
import { useResponsive } from "../../../hooks/use-responsive";
import { useBoolean } from "../../../hooks/use-boolean";
import NotificationItem from "./notification-item";
import { ChromeIconButton } from "../../../layouts/common/chrome-icon-button";
import { POPOVER } from "../../../layouts/config-layout";

// ----------------------------------------------------------------------

export default function NotificationsPopover() {
  const [totalUnRead, setTotalUnread] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const drawer = useBoolean();

  const supabase = createSupabaseFontendClient();

  // The frontend Supabase client is a process-wide singleton and realtime-js
  // (>=2.11.10) dedupes channels by topic, so a fixed channel name shared by two
  // co-mounted instances (both header layouts render this popover) collapses to
  // one already-subscribed channel and `.subscribe()` throws "tried to subscribe
  // multiple times". A per-instance topic keeps each mount on its own channel.
  const channelTopic = `notifications-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  const smUp = useResponsive("up", "sm");

  const { user } = useAuthContext();

  // The notification policy answers for every org the caller belongs to;
  // this client filters to the org on screen. `user.activeTenant` (not
  // `user.tenant`) on purpose: it re-derives from the URL on every render,
  // while `user.tenant` only refreshes on auth events and an org switch is a
  // navigation with no auth event.
  const realtimeNotifications = (filter: string) => {
    return supabase
      .channel(channelTopic)
      .on<Notification>(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notification",
          filter: filter,
        },
        async () => {
          fetchUnReadCount();
          fetchNotifications();
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          fetchUnReadCount();
          fetchNotifications();
        }
      });
  };

  const fetchUnReadCount = async () => {
    const { count } = await supabase
      .from("notification")
      .select("*", { count: "exact", head: true })
      .match({
        tenant_id: user?.activeTenant?.tenant_id,
        read: false,
      });

    setTotalUnread(count || 0);
  };

  const fetchNotifications = async () => {
    const { data } = await supabase
      .from("notification")
      .select("*")
      .match({ tenant_id: user?.activeTenant?.tenant_id })
      .order("created_at", { ascending: false });

    if (data) {
      setNotifications(data);
    }
  };

  const handleMarkAllAsRead = async () => {
    await supabase.from("notification").update({ read: true }).match({
      tenant_id: user?.activeTenant?.tenant_id,
    });
  };

  useEffect(() => {
    if (user?.activeTenant?.tenant_id) {
      const filter = `tenant_id=eq.${user?.activeTenant?.tenant_id}`;
      const sub = realtimeNotifications(filter);

      return () => {
        supabase.removeChannel(sub);
      };
    }
  }, [user?.activeTenant?.tenant_id]);

  const renderHead = (
    <Stack
      direction="row"
      sx={{
        alignItems: "center",
        px: 2,
        minHeight: 56,
        borderBottom: "1px solid",
        borderColor: "divider",
      }}
    >
      <Typography variant="h6" sx={{ flexGrow: 1 }}>
        Notifications
      </Typography>

      {totalUnRead > 0 && (
        <Button
          variant="text"
          size="small"
          onClick={handleMarkAllAsRead}
          sx={{
            color: "primary.main",
            "&:hover": { textDecoration: "underline", bgcolor: "transparent" },
          }}
        >
          Mark all as read
        </Button>
      )}

      {!smUp && (
        <ChromeIconButton
          aria-label="Close notifications"
          onClick={drawer.onFalse}
        >
          <Iconify icon="mdi:close" width={20} />
        </ChromeIconButton>
      )}
    </Stack>
  );

  const renderEmpty = (
    <Stack sx={{ alignItems: "center", textAlign: "center", py: 8, px: 3 }}>
      <Iconify
        icon="mdi:bell-off-outline"
        width={28}
        sx={{ color: "text.disabled" }}
      />
      <Typography variant="body2" sx={{ mt: 1.5, color: "text.secondary" }}>
        You&apos;re all caught up
      </Typography>
      <Typography variant="caption" sx={{ mt: 0.5, color: "text.disabled" }}>
        Deploy, alert, and billing updates land here.
      </Typography>
    </Stack>
  );

  const renderList = (
    <Box sx={{ flexGrow: 1, height: "100%", maxHeight: "100%", overflow: "auto" }}>
      <Box sx={{ minHeight: "100%" }}>
        <List disablePadding>
          {notifications.map((notification) => (
            <NotificationItem key={notification.id} notification={notification} />
          ))}
        </List>
      </Box>
    </Box>
  );

  return (
    <>
      <ChromeIconButton
        aria-label="notifications"
        open={drawer.value}
        onClick={drawer.onTrue}
      >
        <Badge
          badgeContent={totalUnRead}
          color="error"
          max={99}
          sx={{ "& .MuiBadge-badge": { fontSize: 11, fontWeight: 600 } }}
        >
          <Iconify icon="mdi:bell-outline" width={20} />
        </Badge>
      </ChromeIconButton>
      <Drawer
        open={drawer.value}
        onClose={drawer.onFalse}
        anchor="right"
        slotProps={{
          backdrop: { invisible: true },

          paper: {
            sx: {
              width: 1,
              maxWidth: POPOVER.NOTIFICATIONS_WIDTH,
              borderLeft: "1px solid",
              borderColor: "divider",
            },
          },
        }}
      >
        {renderHead}

        {notifications.length === 0 ? renderEmpty : renderList}
      </Drawer>
    </>
  );
}
