"use client";

import { PermissionGuard } from "@/auth/guard";

type Props = {
  children: React.ReactNode;
};

export default function DashboardsLayout({ children }: Props) {
  return (
    <PermissionGuard permission="dashboard.read">{children}</PermissionGuard>
  );
}
