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

interface AppIdProps {
  /**
   * `git_connection.pr_comments_enabled`'s server action — owned by the
   * git-connection feature, not this one. Features are leaves and never
   * import each other, so the caller (the settings page, above both
   * features) supplies it rather than `AppId` importing it directly.
   *
   * Passed as the RAW action reference, not a wrapper closure: a Server
   * Component may only hand a Client Component a function that is itself
   * a Server Action (a top-level export of a `"use server"` module) — a
   * plain async function defined in the page module is not serializable
   * across that boundary and throws at render time. The `{ok, error}` →
   * `{error?}` adaptation `AppPolicyToggle` needs therefore happens HERE,
   * client-side, rather than in the caller.
   */
  setPrCommentsEnabledAction: (input: {
    appId: string;
    value: boolean;
  }) => Promise<{ ok: true } | { ok: false; error: { message: string } }>;
}

export const AppId = ({ setPrCommentsEnabledAction }: AppIdProps) => {
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

        {/* pr_comments_enabled lives on git_connection, not app — separately
            gated on git_connection.update rather than app_policy.update, and
            hidden entirely (not just disabled) from members who can't change
            it, matching the require-pull-request toggle above.

            The default is OFF, and that product call has been MADE (see
            22-git-connection.sql): posting dollar amounts into a repository
            is opt-in, because on a public repo the comment is world-readable
            and permanently indexed, and the column governs every
            already-connected repo at migration time. `?? false` mirrors the
            column default exactly — a UI that showed "on" for a connection
            the database has "off" would misreport the state of a write into
            a customer's repo. The description copy still has to make the
            public-readability of costs unmissable, since that is what a
            person is agreeing to when they flip this.

            Gated on `provider === "github"` as well: the writer posts through
            the GitHub App only, so on a legacy `provider='gitlab'` row this
            toggle would be a switch that silently does nothing — the refresh
            would find no installation and give up without a word. */}
        {gitConnection?.repository &&
          provider === "github" &&
          app?.id &&
          hasPermission(Permissions.GIT_CONNECTION_UPDATE) && (
            <AppPolicyToggle
              initialValue={gitConnection.pr_comments_enabled ?? false}
              canEdit
              save={async (v) => {
                const result = await setPrCommentsEnabledAction({ appId: app.id, value: v });
                return result.ok ? {} : { error: result.error.message };
              }}
              labelKey="dashboard.developers.prCommentsEnabled"
              descriptionKey="dashboard.developers.prCommentsEnabledDescription"
              savedKey="dashboard.developers.prCommentsEnabledSaved"
              noPermissionKey="dashboard.developers.prCommentsEnabledNoPermission"
            />
          )}
      </Stack>
    </SettingsSection>
  );
};
