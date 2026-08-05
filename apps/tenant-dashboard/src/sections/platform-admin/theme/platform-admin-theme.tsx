'use client';

import { useMemo } from 'react';
import { ThemeProvider } from '@mui/material/styles';

import { createPlatformAdminTheme } from '@/theme';

type Props = {
  children: React.ReactNode;
};

// Nested theme with a distinct primary so the admin area reads apart.
export function PlatformAdminTheme({ children }: Props) {
  const adminTheme = useMemo(() => createPlatformAdminTheme(), []);

  return <ThemeProvider theme={adminTheme}>{children}</ThemeProvider>;
}
