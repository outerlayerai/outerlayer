import { getAppIdByName } from "@/utils/get-app-id";
import { WorkersSection } from "@/features/workers";

export const dynamic = "force-dynamic";

export default async function WorkersPage({
  params,
}: {
  params: Promise<{ orgName: string; appName: string }>;
}) {
  const { orgName, appName } = await params;
  const appId = await getAppIdByName(appName);
  if (!appId) return null;

  return <WorkersSection orgName={orgName} appId={appId} />;
}
