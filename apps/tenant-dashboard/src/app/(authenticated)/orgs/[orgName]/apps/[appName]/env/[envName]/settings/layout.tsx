import { getAppIdByName } from "@/utils/get-app-id";
import { getAppPermissionSet } from "@/utils/get-app-permissions";
import { SettingsShell } from "@/components/settings-shell";
import { DEFAULT_ENV_NAME } from "@/lib/environments/default-env-name";
import { AppSettingsNav } from "./app-settings-nav";

type Props = {
  children: React.ReactNode;
  params: Promise<{ orgName: string; appName: string; envName: string }>;
};

export default async function AppSettingsLayout({ children, params }: Props) {
  const { orgName, appName } = await params;

  const appId = await getAppIdByName(appName);

  // One round-trip resolves the full permission set; each tab is a cheap lookup.
  const perms = await getAppPermissionSet(appId);

  // Default-env-only posture: the multi-env UI is removed, so the pages under
  // this layout always resolve the DEFAULT env regardless of the path segment —
  // the header names that env, never a hand-typed `/env/<other>/` segment.
  const shownEnv = DEFAULT_ENV_NAME;

  return (
    <SettingsShell
      heading="App settings"
      description={`${appName} · ${shownEnv} environment`}
      nav={
        <AppSettingsNav
          orgName={orgName}
          appName={appName}
          permissions={Array.from(perms)}
        />
      }
    >
      {children}
    </SettingsShell>
  );
}
