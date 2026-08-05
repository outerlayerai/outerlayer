"use client";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Iconify from "@/components/iconify";

// ----------------------------------------------------------------------

type Props = {
  /** Iconify glyph for the provider (e.g. "mdi:github"). */
  icon: string;
  /** Provider display name (e.g. "GitHub"). */
  name: string;
  connected: boolean;
  username?: string;
  connectedLabel: string;
  notConnectedLabel: string;
  connectLabel: string;
  disconnectLabel: string;
  onConnect: () => void;
  onDisconnect: () => void;
  connecting?: boolean;
};

/**
 * One provider row inside the "Connected accounts" card: a neutral glyph tile,
 * the provider name with a status caption under it, and a trailing action —
 * outlined ink "Connect" or outlined error "Disconnect". Same control language
 * as the rest of settings; no provider-brand fills.
 */
export function ConnectionRow({
  icon,
  name,
  connected,
  username,
  connectedLabel,
  notConnectedLabel,
  connectLabel,
  disconnectLabel,
  onConnect,
  onDisconnect,
  connecting = false,
}: Props) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: "center", py: 1.5 }}>
      <Box
        sx={{
          width: 40,
          height: 40,
          flexShrink: 0,
          borderRadius: 1,
          bgcolor: "background.neutral",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Iconify icon={icon} width={22} />
      </Box>

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle1" component="p">
          {name}
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }} noWrap>
          {connected ? `${connectedLabel} ${username ?? ""}`.trim() : notConnectedLabel}
        </Typography>
      </Box>

      {connected ? (
        <Button variant="outlined" color="error" size="small" onClick={onDisconnect}>
          {disconnectLabel}
        </Button>
      ) : (
        <Button variant="outlined" size="small" onClick={onConnect} disabled={connecting}>
          {connectLabel}
        </Button>
      )}
    </Stack>
  );
}
