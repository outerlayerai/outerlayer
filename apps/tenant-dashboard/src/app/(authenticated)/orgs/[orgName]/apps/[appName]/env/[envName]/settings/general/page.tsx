import { AppId } from "@/features/apps/components/app-id";
import { setPrCommentsEnabledAction } from "@/features/git-connection/actions";
import { Stack } from "@mui/system";

export const metadata = {
  title: "General Settings",
};

async function savePrCommentsEnabled(appId: string, value: boolean): Promise<{ error?: string }> {
  const result = await setPrCommentsEnabledAction({ appId, value });
  return result.ok ? {} : { error: result.error.message };
}

/**
 * General settings page.
 *
 * Shows the App section (`<AppId>`): app id + git connection info — properties
 * of the application itself. Composes the `apps` and `git-connection`
 * features here, above both — `AppId` never imports `git-connection`
 * directly (features are leaves).
 *
 * Default-env-only posture: there is no multi-env UI (breadcrumb switcher, env
 * detail card, promotion), so this page renders no per-environment section.
 */
export default async function GeneralSettingsPage() {
  return (
    <Stack sx={{
      gap: 3
    }}>
      <AppId savePrCommentsEnabled={savePrCommentsEnabled} />
    </Stack>
  );
}
