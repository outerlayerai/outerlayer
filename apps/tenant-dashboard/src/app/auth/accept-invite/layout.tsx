"use client";

import { AuthGuard } from "../../../auth/guard";
import AuthClassicLayout from "../../../layouts/auth/classic";

type Props = {
  children: React.ReactNode;
};

export default function Layout({ children }: Props) {
  return (
    <AuthGuard>
      <AuthClassicLayout title="auth.acceptInvite.welcomeTitle">
        {children}
      </AuthClassicLayout>
    </AuthGuard>
  );
}
