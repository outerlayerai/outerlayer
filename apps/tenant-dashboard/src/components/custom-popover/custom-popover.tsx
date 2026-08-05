import { menuItemClasses } from '@mui/material/MenuItem';
import MenuList from '@mui/material/MenuList';
import Popover from '@mui/material/Popover';

import { StyledArrow } from './styles';
import { getArrowOrigins, getArrowPaperOffset } from './arrow-origins';
import { MenuPopoverProps } from './types';

// ----------------------------------------------------------------------

export default function CustomPopover({
  open,
  children,
  arrow = 'top-right',
  hiddenArrow,
  disableList,
  sx,
  ...other
}: MenuPopoverProps) {
  const { anchorOrigin, transformOrigin } = getArrowOrigins(arrow);

  return (
    <Popover
      open={Boolean(open)}
      anchorEl={open}
      anchorOrigin={anchorOrigin}
      transformOrigin={transformOrigin}
      slotProps={{
        paper: {
          // Consumer `sx` is spread last so its Paper overrides (width, minWidth,
          // p) win over the base + arrow-offset — that Paper-slot styling is part
          // of the contract.
          sx: [
            {
              width: 'auto',
              overflow: 'inherit',
              [`& .${menuItemClasses.root}`]: {
                '& svg': { mr: 2, flexShrink: 0 },
              },
            },
            getArrowPaperOffset(arrow),
            ...(sx ? (Array.isArray(sx) ? sx : [sx]) : []),
          ],
        },
      }}
      {...other}
    >
      {!hiddenArrow && <StyledArrow arrow={arrow} />}

      {disableList ? children : <MenuList disablePadding>{children}</MenuList>}
    </Popover>
  );
}
