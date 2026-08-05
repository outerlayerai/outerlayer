import type { ReactElement } from 'react';

// ----------------------------------------------------------------------
// Derived from `useNavData`'s shape + the consumer call sites. The
// old slotProps/roles/caption/currentRole surface is intentionally dropped — no
// consumer passed it.

export type NavItemData = {
  title: string;
  path: string;
  icon?: ReactElement;
  info?: ReactElement;
  disabled?: boolean;
  // Current nav data is flat; children exist so the rebuild is complete.
  children?: NavItemData[];
};

export type NavGroupData = {
  // Optional: a single-group rail renders its items with no heading (and no
  // collapse toggle). Headings return automatically once a second group exists.
  subheader?: string;
  items: NavItemData[];
};

export type NavSectionProps = {
  data: NavGroupData[];
};

export type NavItemCounterVariant = 'neutral' | 'attention';
