import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import { RouterLink } from '../../routes/components';
import { BreadcrumbsLinkProps } from './types';

// ----------------------------------------------------------------------

type Props = {
  link: BreadcrumbsLinkProps;
  isCurrent: boolean;
};

export default function BreadcrumbsLink({ link, isCurrent }: Props) {
  // The current (last) crumb is the page you're on — non-navigable and flagged
  // for assistive tech.
  if (isCurrent) {
    return (
      <Typography
        component="span"
        aria-current="page"
        sx={{ typography: 'body2', color: 'text.primary' }}
      >
        {link.name}
      </Typography>
    );
  }

  // Earlier crumbs with an href navigate via the router. Trail links are
  // secondary navigation chrome, so they stay muted and only warm to
  // text.primary on hover — overriding the theme's default brand-blue link
  // treatment, which is reserved for primary content links.
  if (link.href) {
    return (
      <Link
        component={RouterLink}
        href={link.href}
        sx={{
          typography: 'body2',
          color: 'text.secondary',
          '&:hover': { color: 'text.primary' },
        }}
      >
        {link.name}
      </Link>
    );
  }

  return (
    <Box component="span" sx={{ typography: 'body2', color: 'text.secondary' }}>
      {link.name}
    </Box>
  );
}
