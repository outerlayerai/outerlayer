import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import ListItemButton from "@mui/material/ListItemButton";
import { format } from "date-fns";
import DOMPurify from "dompurify";
import Iconify from "@/components/iconify";
import { Notification } from "../../../types/notification";
import { createSupabaseFontendClient } from "../../../supabaseFrontendClient";
import { iconForNotificationType } from "./notification-icons";

// ----------------------------------------------------------------------

type NotificationItemProps = {
  notification: Notification;
};

export default function NotificationItem({
  notification,
}: NotificationItemProps) {
  const supabase = createSupabaseFontendClient();

  const handleMarkAsRead = async () => {
    if (!notification.read) {
      await supabase
        .from("notification")
        .update({ read: true })
        .eq("id", notification.id);
    }
  };

  return (
    <ListItemButton
      onClick={handleMarkAsRead}
      disableRipple
      sx={(theme) => ({
        px: 2,
        py: 1.5,
        gap: 1.5,
        alignItems: "flex-start",
        borderRadius: 0,
        borderBottom: "1px solid",
        borderColor: "divider",
        "&:last-of-type": { borderBottom: 0 },
        "&:hover": {
          backgroundColor: (theme.vars ?? theme).palette.action.hover,
        },
      })}
    >
      <Box
        sx={(theme) => ({
          flexShrink: 0,
          width: 32,
          height: 32,
          borderRadius: "6px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          bgcolor: (theme.vars ?? theme).palette.background.neutral,
        })}
      >
        <Iconify
          icon={iconForNotificationType(notification.type)}
          width={18}
          sx={{ color: "text.secondary" }}
        />
      </Box>

      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        {reader(notification.message, !notification.read)}

        <Typography
          variant="caption"
          sx={{ display: "block", mt: 0.25, color: "text.disabled" }}
        >
          {format(new Date(notification.created_at!), "dd MMM yyyy 'at' HH:mm")}
        </Typography>
      </Box>

      {!notification.read && (
        <Box
          data-testid="notification-unread-dot"
          sx={(theme) => ({
            flexShrink: 0,
            mt: 0.75,
            width: 6,
            height: 6,
            borderRadius: "50%",
            bgcolor: (theme.vars ?? theme).palette.primary.main,
          })}
        />
      )}
    </ListItemButton>
  );
}

/** DOMPurify configuration for notification messages - restrictive allowlist */
const DOMPURIFY_CONFIG = {
  ALLOWED_TAGS: ["b", "i", "em", "strong", "p", "a", "br", "ul", "li", "span"],
  ALLOWED_ATTR: ["href", "target", "rel"],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

// The sanitized message HTML IS the notification's title (there is no separate
// title column) and carries the only routing this surface has (embedded <a>),
// so the DOMPurify config and anchor styling are preserved verbatim. Unread
// rows render the message at weight 600 for emphasis.
function reader(data: string, unread: boolean) {
  return (
    <Box
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(data, DOMPURIFY_CONFIG),
      }}
      sx={{
        typography: "body2",
        color: "text.primary",
        fontWeight: unread ? 600 : 400,
        "& p": { m: 0, fontWeight: "inherit" },
        "& a": { color: "inherit", textDecoration: "none" },
        "& strong": { fontWeight: 600 },
      }}
    />
  );
}
