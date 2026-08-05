'use client';

import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Breadcrumbs from '@mui/material/Breadcrumbs';

import LinkItem from './link-item';
import { CustomBreadcrumbsProps } from './types';

// ----------------------------------------------------------------------

export default function CustomBreadcrumbs({
  links,
  action,
  heading,
  sx,
  ...other
}: CustomBreadcrumbsProps) {
  const lastIndex = links.length - 1;

  return (
    <Box sx={sx}>
      <Stack direction="row" sx={{ alignItems: 'center' }}>
        <Box sx={{ flexGrow: 1 }}>
          {/* HEADING — the page title (theme's h4 page-title variant). */}
          {heading && (
            <Typography variant="h4" gutterBottom>
              {heading}
            </Typography>
          )}

          {/* BREADCRUMBS */}
          {!!links.length && (
            <Breadcrumbs separator={<Separator />} {...other}>
              {links.map((link, index) => (
                <LinkItem
                  key={`${link.name ?? ''}-${index}`}
                  link={link}
                  isCurrent={index === lastIndex}
                />
              ))}
            </Breadcrumbs>
          )}
        </Box>

        {action && <Box sx={{ flexShrink: 0 }}>{action}</Box>}
      </Stack>
    </Box>
  );
}

// ----------------------------------------------------------------------

function Separator() {
  // A small muted dot between crumbs — quieter than MUI's default slash and
  // consistent with the theme's low-chrome dividers.
  return (
    <Box
      component="span"
      sx={{
        width: 4,
        height: 4,
        borderRadius: '50%',
        bgcolor: 'text.disabled',
      }}
    />
  );
}
