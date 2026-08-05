import { useState } from 'react';

import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';

import { NavItemVertical } from './nav-item';
import { getNavSubheaderStyles } from './styles';
import type { NavGroupData, NavSectionProps } from './types';

// ----------------------------------------------------------------------
// Items render directly in a plain container (no MUI List/`ul`) so the anchors
// are the only interactive semantics — cleaner for axe than a `ul` full of
// non-`li` button rows.

function NavGroupItems({ group }: { group: NavGroupData }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      {group.items.map((item) => (
        <NavItemVertical key={item.path} item={item} depth={1} />
      ))}
    </Box>
  );
}

function NavGroupVertical({ group }: { group: NavGroupData }) {
  const [open, setOpen] = useState(true);

  // No subheader: render the items directly with no heading and no collapse
  // toggle. The group stays permanently expanded.
  if (!group.subheader) {
    return (
      <Box>
        <NavGroupItems group={group} />
      </Box>
    );
  }

  return (
    <Box>
      <ButtonBase
        disableRipple
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        sx={(theme) => getNavSubheaderStyles(theme)}
      >
        <Typography variant="overline" color="inherit" noWrap>
          {group.subheader}
        </Typography>
      </ButtonBase>

      <Collapse in={open} unmountOnExit>
        <NavGroupItems group={group} />
      </Collapse>
    </Box>
  );
}

export function NavSectionVertical({ data }: NavSectionProps) {
  return (
    <Box component="nav" sx={{ display: 'flex', flexDirection: 'column', py: 1 }}>
      {data.map((group, index) => (
        <NavGroupVertical key={group.subheader ?? index} group={group} />
      ))}
    </Box>
  );
}
