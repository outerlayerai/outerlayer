'use client';

/**
 * <AppBreadcrumb.AppSelect> — the App segment of the breadcrumb spine
 *
 * An app switcher scoped to the current org. The list of apps arrives seeded
 * from the `[appName]` React Server Component (RSC) layout (`AppListContext`) — RLS already scoped it
 * to the caller's tenant + app-level roles server-side, so this component
 * fetches nothing itself. Selecting an app navigates to that app's root — env
 * state is intentionally NOT carried across an app switch, because `?env=`
 * names an environment of a *specific* app.
 *
 * Mirrors `OrgSwitcher`'s interaction shape (ButtonBase + Menu) so the three
 * breadcrumb segments read as one consistent spine.
 */

import { useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemText from '@mui/material/ListItemText';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import ButtonBase from '@mui/material/ButtonBase';
import { useTheme } from '@mui/material/styles';
import Iconify from '@/components/iconify';

import { useAppList } from '@/lib/app-shell/app-context';
import { usePopover } from '@/components/custom-popover';
import { paths } from '@/routes/paths';

export function AppSelect() {
  const theme = useTheme();
  const router = useRouter();
  const popover = usePopover();
  const { orgName, appName } = useParams();

  const currentOrg = Array.isArray(orgName) ? orgName[0] : orgName;
  const currentApp = Array.isArray(appName) ? appName[0] : appName;

  const apps = useAppList();

  const handleSelect = useCallback(
    (name: string) => {
      popover.onClose();
      if (!currentOrg || name === currentApp) {
        return;
      }
      router.push(paths.orgs.org.apps.app.root(currentOrg, name));
    },
    [popover, router, currentOrg, currentApp],
  );

  // "View all apps" escape hatch — the apps list is otherwise only reachable
  // by first stepping out to the org page, so surface it here in the one
  // control that already represents "the app you're in".
  const handleViewAllApps = useCallback(() => {
    popover.onClose();
    if (!currentOrg) {
      return;
    }
    router.push(paths.orgs.org.apps.root(currentOrg));
  }, [popover, router, currentOrg]);

  // Outside an app route there is no app segment to render.
  if (!currentApp) {
    return null;
  }

  const open = Boolean(popover.open);
  const list = apps;

  // The URL segment is the slug (`name`); show the friendlier `display_name`
  // when the current app has one. Falls back to the slug while the list loads.
  const currentLabel =
    list.find((appRow) => appRow.name === currentApp)?.display_name ||
    currentApp;

  return (
    <>
      <ButtonBase
        onClick={popover.onOpen}
        aria-label="Select app"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          height: 32,
          px: 1,
          borderRadius: '6px',
          transition: theme.transitions.create(['background-color']),
          '&:hover': { bgcolor: 'action.hover' },
          ...(open && { bgcolor: 'background.neutral' }),
        }}
      >
        <Typography
          variant="body2"
          sx={{
            fontWeight: 500,
            color: 'text.primary',
            // Breakpoint-aware clamp. Tight on mobile (~390px) so three
            // segments + separators fit the viewport; generous on desktop. A
            // long app name ellipsises here rather than pushing the layout.
            maxWidth: { xs: 96, sm: 160, lg: 240 },
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {currentLabel}
        </Typography>
        <Iconify
          icon="mdi:chevron-down"
          width={16}
          sx={{
            color: 'text.secondary',
            transition: theme.transitions.create('transform'),
            ...(open && { transform: 'rotate(180deg)' }),
          }}
        />
      </ButtonBase>

      <Menu
        anchorEl={popover.open}
        open={open}
        onClose={popover.onClose}
        transformOrigin={{ horizontal: 'left', vertical: 'top' }}
        anchorOrigin={{ horizontal: 'left', vertical: 'bottom' }}
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
        <Typography
          variant="overline"
          sx={{
            px: 2,
            py: 1,
            display: 'block',
            color: 'text.secondary',
            fontSize: 11,
          }}
        >
          Switch app
        </Typography>

        {list.map((appRow) => (
          <MenuItem
            key={appRow.id}
            onClick={() => handleSelect(appRow.name)}
            selected={appRow.name === currentApp}
            sx={{ py: 1, px: 2 }}
          >
            <ListItemText
              primary={appRow.display_name || appRow.name}
              slotProps={{
                primary: { variant: 'body2', noWrap: true, sx: { fontWeight: 500 } },
              }}
            />
            {appRow.name === currentApp && (
              <Iconify
                icon="eva:checkmark-fill"
                width={16}
                sx={{ color: 'primary.main', ml: 1 }}
              />
            )}
          </MenuItem>
        ))}

        <Divider sx={{ my: 0.5 }} />

        <MenuItem onClick={handleViewAllApps} sx={{ py: 1, px: 2 }}>
          <Iconify
            icon="eva:grid-outline"
            width={16}
            sx={{ color: 'text.secondary', mr: 1 }}
          />
          <ListItemText
            primary="View all apps"
            slotProps={{
              primary: { variant: 'body2', sx: { fontWeight: 500, color: 'text.secondary' } },
            }}
          />
        </MenuItem>
      </Menu>
    </>
  );
}
