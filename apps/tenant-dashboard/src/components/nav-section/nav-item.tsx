import { useState } from 'react';
import type { MouseEvent } from 'react';

import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import ListItemButton from '@mui/material/ListItemButton';
import { styled } from '@mui/material/styles';

import { RouterLink } from '@/routes/components';
import { useActiveLink } from '@/routes/hooks';

import { useNavHref } from './use-nav-href';
import {
  getNavItemStyles,
  getNavItemActiveStyles,
  getSubItemDotStyles,
  getNavIconSlotStyles,
} from './styles';
import type { NavItemData } from './types';

// ----------------------------------------------------------------------

const NavItemButton = styled(ListItemButton, {
  shouldForwardProp: (prop) => prop !== 'active' && prop !== 'depth',
})<{ active?: boolean; depth?: number }>(({ theme, depth = 1 }) => ({
  ...getNavItemStyles(theme, { depth }),
  variants: [
    {
      props: { active: true },
      style: getNavItemActiveStyles(theme, { depth }),
    },
  ],
}));

// Trailing chevron on parent items — an inline SVG (the app's Iconify glyphs
// render `null` under unit tests, and this control needs to be visible + tested).
// It rotates 90° when the parent is open.
function NavChevron({ open }: { open: boolean }) {
  return (
    <Box
      component="span"
      aria-hidden
      data-testid="nav-item-chevron"
      sx={(theme) => ({
        ml: 0.5,
        display: 'inline-flex',
        alignItems: 'center',
        color: 'text.secondary',
        transition: theme.transitions.create('transform', {
          duration: theme.transitions.duration.shortest,
        }),
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      })}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </Box>
  );
}

// ----------------------------------------------------------------------

type NavItemVerticalProps = {
  item: NavItemData;
  depth?: number;
};

export function NavItemVertical({ item, depth = 1 }: NavItemVerticalProps) {
  const active = useActiveLink(item.path);
  const external = item.path.startsWith('http');
  const href = useNavHref(item.path, external);
  const hasChildren = Boolean(item.children?.length);

  const [open, setOpen] = useState(active);

  // Every enabled item must render as a real `<a>` with an href: the e2e suite
  // selects sidebar links by `a[href*=…]`. Disabled items render as a non-navigating control; external
  // links open in a new tab; internal links go through RouterLink.
  const linkProps = item.disabled
    ? { 'aria-disabled': true as const }
    : external
      ? {
          component: 'a' as const,
          href,
          target: '_blank',
          rel: 'noopener noreferrer',
        }
      : { component: RouterLink, href };

  const handleClick = hasChildren
    ? (event: MouseEvent) => {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    : undefined;

  return (
    <>
      <NavItemButton
        disableRipple
        active={active}
        depth={depth}
        disabled={item.disabled}
        aria-current={active ? 'page' : undefined}
        aria-expanded={hasChildren ? open : undefined}
        onClick={handleClick}
        {...linkProps}
      >
        <Box
          component="span"
          sx={{
            // Unified 24px icon slot (same as mini) + the label gap. The 8px
            // paddingLeft in getNavItemStyles keeps this slot's centre anchored
            // at the mini slot's x across collapse/expand.
            ...getNavIconSlotStyles(),
            mr: 1.5,
          }}
        >
          {depth >= 2 ? (
            <Box
              component="span"
              sx={(theme) => getSubItemDotStyles(theme, { active })}
            />
          ) : (
            item.icon
          )}
        </Box>

        <Box
          component="span"
          className="nav-label"
          sx={{
            flexGrow: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            typography: 'body2',
            fontWeight: 500,
          }}
        >
          {item.title}
        </Box>

        {item.info && (
          <Box
            component="span"
            sx={{ ml: 1, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
          >
            {item.info}
          </Box>
        )}

        {hasChildren && <NavChevron open={open} />}
      </NavItemButton>

      {hasChildren && (
        <Collapse in={open} unmountOnExit>
          {item.children!.map((child) => (
            <NavItemVertical key={child.path} item={child} depth={depth + 1} />
          ))}
        </Collapse>
      )}
    </>
  );
}
