import type { Metadata } from "next";
import ProfileSettings from "../../../features/profile/components/profile-settings";

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: "Profile Settings",
};

type ProfilePageProps = {
  searchParams: Promise<{
    email_change?: string;
    email_error?: string;
  }>;
};

export default async function OverviewAppPage({ searchParams }: ProfilePageProps) {
  const params = await searchParams;
  return (
    <ProfileSettings
      emailChangeStatus={params.email_change}
      emailChangeError={params.email_error}
    />
  );
}
