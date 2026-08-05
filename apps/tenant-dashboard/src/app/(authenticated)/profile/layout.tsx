"use client";

import { useTranslate } from "@outerlayer/locales";
import { AppLayout } from "../../../layouts/app/app-layout";
import { SettingsShell } from "@/components/settings-shell";
import { ProfileNav } from "./profile-nav";

type Props = {
  children: React.ReactNode;
};

export default function Layout({ children }: Props) {
  const { t } = useTranslate();

  return (
    <AppLayout>
      <SettingsShell heading={t("dashboard.profileSettings.pageTitle")} nav={<ProfileNav />}>
        {children}
      </SettingsShell>
    </AppLayout>
  );
}
