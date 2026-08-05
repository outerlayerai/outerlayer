import { BreadcrumbsProps } from '@mui/material/Breadcrumbs';

// ----------------------------------------------------------------------

export type BreadcrumbsLinkProps = {
  name?: string;
  href?: string;
};

export interface CustomBreadcrumbsProps extends BreadcrumbsProps {
  heading?: string;
  action?: React.ReactNode;
  links: BreadcrumbsLinkProps[];
}
