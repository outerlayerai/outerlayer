import Box from '@mui/material/Box';

import { NavItemMini } from './nav-item-mini';
import type { NavSectionProps } from './types';

// ----------------------------------------------------------------------
// Groups are concatenated with no subheaders (decision D5): the mini anatomy
// has no header treatment and there is exactly one group today.

export function NavSectionMini({ data }: NavSectionProps) {
  const items = data.flatMap((group) => group.items);

  return (
    <Box component="nav" sx={{ display: 'flex', flexDirection: 'column', py: 1 }}>
      {items.map((item) => (
        <NavItemMini key={item.path} item={item} />
      ))}
    </Box>
  );
}
