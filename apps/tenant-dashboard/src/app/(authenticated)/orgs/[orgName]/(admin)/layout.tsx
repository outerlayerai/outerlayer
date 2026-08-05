"use client";

import AdminGuard from "../../../../../auth/guard/admin-guard";
import { AppLayout } from "../../../../../layouts/app";
import { LicenseGraceBanner } from "@ee/features/license/components/license-grace-banner";

type Props = {
  children: React.ReactNode;
};

export default function Layout({ children }: Props) {
  return (
      <AdminGuard>
        <AppLayout>
          {/* Renders only while a self-host license is in its grace window
              (fail-closed BFF); nothing on Cloud/valid/unlicensed. */}
          <LicenseGraceBanner />
          {children}
        </AppLayout>
      </AdminGuard>
  );
}
