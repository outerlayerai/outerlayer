import { MenuItem, MenuList } from "@mui/material";
import CustomPopover from '@/components/custom-popover';
import Iconify from "@/components/iconify";
import type { AppWithGitConnection } from "../types";

type Props = {
  open: HTMLElement | null;
  onClose: VoidFunction;
  app?: AppWithGitConnection;
  canLinkGit: boolean;
  canDeleteApp: boolean;
  canRenameApp: boolean;
  onConnectProvider: (appId: string) => void;
  onLinkRepository: VoidFunction;
  onRenameApp: VoidFunction;
  onDeleteApp: VoidFunction;
  t: (key: string) => string;
};

const getProviderIcon = (_provider: string | null) => "mdi:github";

export const AppSettingsMenu = ({
  canDeleteApp,
  canRenameApp,
  app,
  canLinkGit,
  open,
  t,
  onClose,
  onConnectProvider,
  onLinkRepository,
  onRenameApp,
  onDeleteApp,
}: Props) => {
  const providerIcon = getProviderIcon(app?.provider ?? null);

  return (
    <CustomPopover open={open} onClose={onClose} disableList>
      <MenuList>
        {canRenameApp && (
          <MenuItem onClick={onRenameApp}>
            <Iconify width={18} icon="ic:round-edit" />
            {t("settingsMenu.rename")}
          </MenuItem>
        )}
        {canDeleteApp && (
          <MenuItem onClick={onDeleteApp}>
            <Iconify width={18} icon="ic:round-delete" />
            {t("settingsMenu.delete")}
          </MenuItem>
        )}
        {canLinkGit &&
          (!app?.isGitConnected ? (
            <MenuItem onClick={() => onConnectProvider(app?.id!)}>
              <Iconify width={18} icon="mdi:git" />
              {t("settingsMenu.connectGit")}
            </MenuItem>
          ) : !app?.repository ? (
            <MenuItem onClick={onLinkRepository}>
              <Iconify width={18} icon={providerIcon} />
              {t("settingsMenu.linkRepository")}
            </MenuItem>
          ) : (
            [
              <MenuItem key="linkRepository" onClick={onLinkRepository}>
                <Iconify width={18} icon={providerIcon} />
                {t("settingsMenu.updateRepo")}
              </MenuItem>,
              <MenuItem
                key="connectProvider"
                onClick={() => onConnectProvider(app.id)}
              >
                <Iconify width={18} icon="mdi:git" />
                {t("settingsMenu.changeProvider")}
              </MenuItem>,
            ]
          ))}
      </MenuList>
    </CustomPopover>
  );
};
