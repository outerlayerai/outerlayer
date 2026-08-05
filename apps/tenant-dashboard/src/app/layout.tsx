import InitColorSchemeScript from '@mui/material/InitColorSchemeScript';
import { ThemeProvider } from '@/theme';
import { SettingsProvider } from '@/components/settings';
import ProgressBar from '@/components/progress-bar';
import i18n from "../locales/i18n";
import { AuthProvider } from "../auth/context";
import { LocalizationProvider } from "@outerlayer/locales";
import { SnackbarProvider } from '@/components/snackbar';
import * as Sentry from "@sentry/nextjs";
import type { Metadata } from "next";

// Add or edit your "generateMetadata" to include the Sentry trace data:
export function generateMetadata(): Metadata {
  return {
    // ... your existing metadata
    other: {
      ...Sentry.getTraceData(),
    },
  };
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <InitColorSchemeScript attribute="class" defaultMode="light" />
        <AuthProvider>
          <LocalizationProvider i18n={i18n}>
            <ThemeProvider>
              <SettingsProvider
                defaultSettings={{
                  themeLayout: "vertical",
                  themeMode: "light",
                }}
              >
                <SnackbarProvider>
                  <ProgressBar />
                  {children}
                </SnackbarProvider>
              </SettingsProvider>
            </ThemeProvider>
          </LocalizationProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
