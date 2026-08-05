import type { Metadata } from "next";
import { Stack } from "@mui/material";
import { SettingsSection } from "@/components/settings-shell";
import GitHubAuthForm from "@/features/profile/components/github-auth-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Profile · Connections",
};

export default function ProfileConnectionsPage() {
  return (
    <SettingsSection
      title="Connected accounts"
      description="Link a GitHub account to connect repositories."
    >
      <Stack>
        <GitHubAuthForm />
      </Stack>
    </SettingsSection>
  );
}
