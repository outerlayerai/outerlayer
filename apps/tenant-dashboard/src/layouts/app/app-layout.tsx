"use client";

import { LayoutMain } from "../content-frame";

// ----------------------------------------------------------------------

type Props = {
  children: React.ReactNode;
};

// Org-level shell: just the content frame. The header is the persistent
// AppHeader in `(authenticated)/layout.tsx`; this shell mounts none.
export function AppLayout({ children }: Props) {
  return <LayoutMain>{children}</LayoutMain>;
}
