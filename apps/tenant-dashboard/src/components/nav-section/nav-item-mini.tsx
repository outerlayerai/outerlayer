import { useState } from 'react';
import type { MouseEvent } from 'react';

import Box from '@mui/material/Box';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import ListItemButton from '@mui/material/ListItemButton';
import { styled } from '@mui/material/styles';

import { RouterLink } from '@/routes/components';
import { useActiveLink } from '@/routes/hooks';

import { useNavHref } from './use-nav-href';
import {
  getMiniItemStyles,
  getMiniDotStyles,
  getMiniIconSlotStyles,
  getNavItemActiveStyles,
} from './styles';
import type { NavItemData } from './types';

// ----------------------------------------------------------------------

const MiniItemButton = styled(ListItemButton, {
  shouldForwardProp: (prop) => prop !== 'active',
})<{ active?: boolean }>(({ theme }) => ({
  ...getMiniItemStyles(theme),
  variants: [
    {
      props: { active: true },
      style: getNavItemActiveStyles(theme, { depth: 1 }),
    },
  ],
}));

function externalLinkProps(href: string) {
  return { component: 'a' as const, href, target: '_blank', rel: 'noopener noreferrer' };
}

// A child rendered inside the mini parent's right-anchored Menu (decision D6).
function MiniChildMenuItem({
  item,
  onNavigate,
}: {
  item: NavItemData;
  onNavigate: () => void;
}) {
  const active = useActiveLink(item.path);
  const external = item.path.startsWith('http');
  const href = useNavHref(item.path, external);
  const linkProps = external ? externalLinkProps(href) : { component: RouterLink, href };

  return (
    <MenuItem
      selected={active}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      {...linkProps}
    >
      {item.title}
    </MenuItem>
  );
}

// ----------------------------------------------------------------------

export function NavItemMini({ item }: { item: NavItemData }) {
  const active = useActiveLink(item.path);
  const external = item.path.startsWith('http');
  const href = useNavHref(item.path, external);
  const hasChildren = Boolean(item.children?.length);

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  // A parent opens a menu instead of navigating; a leaf navigates.
  const linkProps = item.disabled
    ? { 'aria-disabled': true as const }
    : hasChildren
      ? {}
      : external
        ? externalLinkProps(href)
        : { component: RouterLink, href };

  const handleClick = hasChildren
    ? (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        setAnchorEl(event.currentTarget);
      }
    : undefined;

  // The label lives only in the tooltip (no visible mini label);
  // the numeric count rides alongside it (decision D4).
  const tooltipTitle = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <span>{item.title}</span>
      {item.info}
    </Box>
  );

  return (
    <>
      <Tooltip title={tooltipTitle} placement="right" disableInteractive>
        <MiniItemButton
          disableRipple
          active={active}
          disabled={item.disabled}
          aria-label={item.title}
          aria-current={active ? 'page' : undefined}
          aria-haspopup={hasChildren ? 'menu' : undefined}
          onClick={handleClick}
          {...linkProps}
        >
          <Box
            component="span"
            sx={getMiniIconSlotStyles()}
          >
            {item.icon}
          </Box>

          {item.info && (
            <Box component="span" sx={(theme) => getMiniDotStyles(theme)}>
              {item.info}
            </Box>
          )}
        </MiniItemButton>
      </Tooltip>

      {hasChildren && (
        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={() => setAnchorEl(null)}
          anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        >
          {item.children!.map((child) => (
            <MiniChildMenuItem
              key={child.path}
              item={child}
              onNavigate={() => setAnchorEl(null)}
            />
          ))}
        </Menu>
      )}
    </>
  );
}
