import { AppId } from "@/features/apps/components/app-id";
import { setPrCommentsEnabledAction } from "@/features/git-connection/actions";
import { Stack } from "@mui/system";

export const metadata = {
  title: "General Settings",
};

/**
 * General settings page.
 *
 * Shows the App section (`<AppId>`): app id + git connection info — properties
 * of the application itself. Composes the `apps` and `git-connection`
 * features here, above both — `AppId` never imports `git-connection`
 * directly (features are leaves).
 *
 * Passes `setPrCommentsEnabledAction` straight through, unwrapped: it is
 * itself a Server Action (a top-level export of a `"use server"` module),
 * which is the only kind of function a Server Component may hand to a
 * Client Component as a prop. A wrapper defined in this page module would
 * not be serializable across that boundary and would throw at render time
 * — the `{ok, error}` → `{error?}` adaptation for `AppPolicyToggle` happens
 * inside `AppId` instead.
 *
 * Default-env-only posture: there is no multi-env UI (breadcrumb switcher, env
 * detail card, promotion), so this page renders no per-environment section.
 */
export default async function GeneralSettingsPage() {
  return (
    <Stack sx={{
      gap: 3
    }}>
      <AppId setPrCommentsEnabledAction={setPrCommentsEnabledAction} />
    </Stack>
  );
}
