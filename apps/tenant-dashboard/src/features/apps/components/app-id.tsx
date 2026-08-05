"use client";

import { CopyableId } from "@/components/common/copyable-id";
import { useAppContext } from "@/lib/app-shell/app-context";
import { useTranslate } from "@outerlayer/locales";
import { SettingsSection } from "@/components/settings-shell";
import { Typography } from "@mui/material";
import { Stack } from "@mui/system";
import { ProviderBadge } from "@/components/provider-badge";
import type { GitProviderType } from "@/lib/adapters/git-provider-type";
import { useAppPermissions } from "@/lib/adapters/use-app-permissions";
import { Permissions } from "@/utils/permissions";
import { AppPolicyToggle } from "./app-policy-toggle";
import { setAppPolicyAction } from "../actions";

async function saveRequirePullRequest(appId: string, value: boolean): Promise<{ error?: string }> {
  const result = await setAppPolicyAction({ appId, policy: "require_pull_request", value });
  return result.ok ? {} : { error: result.error.message };
}

type DetailItem = {
  label: string;
  value: string | undefined;
  show?: boolean;
  isCopyable?: boolean;
  isProvider?: boolean;
};

export const AppId = () => {
  const { app } = useAppContext();
  const { t } = useTranslate();
  const { hasPermission } = useAppPermissions(app?.id);

  const gitConnection = app?.git_connection?.[0];
  const provider = gitConnection?.provider as GitProviderType | undefined;

  const details: DetailItem[] = [
    {
      label: t("dashboard.developers.appId"),
      value: app?.id,
      isCopyable: true,
    },
    {
      label: t("dashboard.developers.provider"),
      value: provider,
      show: !!provider,
      isProvider: true,
    },
    {
      label: t("dashboard.developers.repository"),
      value: gitConnection?.repository ?? undefined,
      show: !!gitConnection?.repository,
    },
    {
      label: t("dashboard.developers.branch"),
      value: app?.git_branch?.[0]?.branch_name ?? undefined,
      show: !!app?.git_branch?.[0]?.branch_name,
    },
  ];

  return (
    <SettingsSection
      title={t("dashboard.developers.generalTitle")}
      description={t("dashboard.developers.generalDescription")}
    >
      <Stack spacing={2}>
        {details.map(
          ({ label, value, show = true, isCopyable, isProvider }) =>
            show && (
              <Stack key={label}>
                {isCopyable ? (
                  <CopyableId label={label} id={value as string} />
                ) : (
                  <Stack direction="row" spacing={1} sx={{
                    alignItems: "center"
                  }}>
                    <Typography
                      variant="body2"
                      sx={{
                        fontWeight: "bold",
                        color: "text.secondary",
                        minWidth: 100
                      }}>
                      {label}
                    </Typography>
                    {isProvider && provider ? (
                      <ProviderBadge provider={provider} size="small" />
                    ) : (
                      <Typography variant="body2" sx={{
                        color: "text.secondary"
                      }}>
                        {value}
                      </Typography>
                    )}
                  </Stack>
                )}
              </Stack>
            )
        )}

        {/* Publish policies live with the git connection — only meaningful when
            a repository is connected. Hidden entirely from members who can't
            change them (no app_policy.update); the server action + the
            enforce_app_policy_permission trigger remain the authoritative gate. */}
        {gitConnection?.repository &&
          app?.id &&
          hasPermission(Permissions.APP_POLICY_UPDATE) && (
            <AppPolicyToggle
              initialValue={app.require_pull_request ?? false}
              canEdit
              save={(v) => saveRequirePullRequest(app.id, v)}
              labelKey="dashboard.developers.requirePullRequest"
              descriptionKey="dashboard.developers.requirePullRequestDescription"
              savedKey="dashboard.developers.requirePullRequestSaved"
              noPermissionKey="dashboard.developers.requirePullRequestNoPermission"
            />
          )}
      </Stack>
    </SettingsSection>
  );
};
