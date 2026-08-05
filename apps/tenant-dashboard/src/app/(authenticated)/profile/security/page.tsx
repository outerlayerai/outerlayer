import type { Metadata } from "next";
import ChangePasswordForm from "@/features/profile/components/change-password-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Profile · Security",
};

export default function ProfileSecurityPage() {
  return <ChangePasswordForm />;
}
