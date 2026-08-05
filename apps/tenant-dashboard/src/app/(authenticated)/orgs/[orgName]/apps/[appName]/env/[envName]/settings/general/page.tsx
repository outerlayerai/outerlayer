import { AppId } from "@/features/apps/components/app-id";
import { Stack } from "@mui/system";

export const metadata = {
  title: "General Settings",
};

/**
 * General settings page.
 *
 * Shows the App section (`<AppId>`): app id + git connection info — properties
 * of the application itself.
 *
 * Default-env-only posture: there is no multi-env UI (breadcrumb switcher, env
 * detail card, promotion), so this page renders no per-environment section.
 */
export default async function GeneralSettingsPage() {
  return (
    <Stack sx={{
      gap: 3
    }}>
      <AppId />
    </Stack>
  );
}
