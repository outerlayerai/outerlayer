import { Box, Card, IconButton, Tooltip, Typography } from "@mui/material";
import Iconify from "@/components/iconify";

import { ProviderBadge } from "@/components/provider-badge";
import type { AppWithGitConnection } from "../types";
import {
  activityStampSx,
  appNameSx,
  cardSx,
  envChipSx,
  envChipsWrapSx,
  envLabelSx,
  envVersionSx,
  footerSx,
  formatEnvChipLabel,
  formatRelativeActivity,
  gearButtonSx,
  headerRowSx,
  notConnectedSx,
  overflowChipSx,
  repoLineSx,
  repoTextSx,
  selectEnvChips,
} from "./app-card-styles";

type Props = {
  canDeleteApp: boolean;
  canRenameApp: boolean;
  canLinkGit: boolean;
  app: AppWithGitConnection;
  onSettingsClick: (e: React.MouseEvent<HTMLElement>) => void;
  onCardClick: (e: React.MouseEvent<HTMLElement>) => void;
  t: (key: string) => string;
};

export const AppCard = ({
  canDeleteApp,
  canRenameApp,
  canLinkGit,
  app,
  onCardClick,
  onSettingsClick,
}: Props) => {
  const displayName = app.display_name || app.name;
  const canOpenSettings = canDeleteApp || canRenameApp || canLinkGit;
  const hasRepo = Boolean(app.provider && app.repository);

  const { chips, hidden, overflow } = selectEnvChips(app.environments);
  const activityIso = app.updated_at ?? app.created_at;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onCardClick(e as unknown as React.MouseEvent<HTMLElement>);
    }
  };

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-label={`Open ${displayName}`}
      onClick={onCardClick}
      onKeyDown={handleKeyDown}
      sx={cardSx}
    >
      <Box sx={headerRowSx}>
        <Typography variant="subtitle1" noWrap sx={appNameSx}>
          {displayName}
        </Typography>
        {canOpenSettings && (
          <IconButton
            aria-label="App settings"
            sx={gearButtonSx}
            onClick={(e) => {
              e.stopPropagation(); // gear must not activate the card
              onSettingsClick(e);
            }}
          >
            <Iconify icon="mdi:cog-outline" width={18} height={18} />
          </IconButton>
        )}
      </Box>

      <Box sx={repoLineSx}>
        {hasRepo ? (
          <>
            <ProviderBadge provider={app.provider!} showLabel={false} size="small" />
            <Typography
              component="span"
              noWrap
              title={`${app.repository}${app.connectedBranch ? ` · ${app.connectedBranch}` : ""}`}
              sx={repoTextSx}
            >
              {app.repository}
              {app.connectedBranch && ` · ${app.connectedBranch}`}
            </Typography>
          </>
        ) : (
          <Typography variant="body2" sx={notConnectedSx}>
            Not connected to git
          </Typography>
        )}
      </Box>

      <Box sx={footerSx}>
        <Box sx={envChipsWrapSx}>
          {chips.map((chip) => (
            <Tooltip key={chip.name} title={formatEnvChipLabel(chip)}>
              <Box component="span" sx={envChipSx}>
                <Box component="span" sx={envLabelSx}>
                  {chip.name}
                  {chip.version != null && (
                    <Box component="span" sx={envVersionSx}>
                      ·v{chip.version}
                    </Box>
                  )}
                </Box>
              </Box>
            </Tooltip>
          ))}
          {overflow > 0 && (
            <Tooltip title={hidden.map(formatEnvChipLabel).join(", ")}>
              <Box component="span" sx={overflowChipSx}>
                +{overflow}
              </Box>
            </Tooltip>
          )}
        </Box>
        {activityIso && (
          <Typography variant="caption" sx={activityStampSx}>
            {formatRelativeActivity(activityIso)}
          </Typography>
        )}
      </Box>
    </Card>
  );
};
