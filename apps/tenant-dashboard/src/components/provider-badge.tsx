"use client";

import Chip from "@mui/material/Chip";
import Iconify from "@/components/iconify";
import type { GitProviderType } from "@/lib/adapters/git-provider-type";

// ----------------------------------------------------------------------

interface ProviderConfig {
  name: string;
  icon: string;
  color: string;
  bgColor: string;
}

const providerConfigs: Record<GitProviderType, ProviderConfig> = {
  github: {
    name: "GitHub",
    icon: "mdi:github",
    color: "#24292e",
    bgColor: "#f6f8fa",
  },
};

// ----------------------------------------------------------------------

interface ProviderBadgeProps {
  provider: GitProviderType;
  size?: "small" | "medium";
  showLabel?: boolean;
}

/**
 * Badge displaying the Git provider type.
 */
export function ProviderBadge({
  provider,
  size = "small",
  showLabel = true,
}: ProviderBadgeProps) {
  const config = providerConfigs[provider] || providerConfigs.github;
  const iconSize = size === "small" ? 16 : 20;

  // Icon-only mode: a bare brand-colored glyph, no Chip. A MUI Chip always
  // renders its (empty) label span with padding, so a label-less Chip leaves a
  // phantom gap to the right of the icon; the tinted pill also isn't the app
  // card's language. Consumed by <AppCard>.
  if (!showLabel) {
    return (
      <Iconify
        icon={config.icon}
        width={iconSize}
        height={iconSize}
        sx={{ color: config.color }}
      />
    );
  }

  // Labeled Chip: the settings surface's provider pill — unchanged.
  return (
    <Chip
      size={size}
      icon={
        <Iconify
          icon={config.icon}
          width={iconSize}
          height={iconSize}
          sx={{ color: `${config.color} !important` }}
        />
      }
      label={config.name}
      sx={{
        bgcolor: config.bgColor,
        color: config.color,
        fontWeight: 500,
        cursor: "default",
        "&:hover": {
          bgcolor: config.bgColor,
        },
        "& .MuiChip-icon": {
          ml: 0.5,
          mr: -0.5,
        },
      }}
    />
  );
}

