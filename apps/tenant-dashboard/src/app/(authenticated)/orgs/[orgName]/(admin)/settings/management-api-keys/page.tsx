import { ManagementApiKeysPanel } from "@/features/management-api-keys";
import { loadManagementApiKeys } from "@/features/management-api-keys/read";

export const metadata = {
  title: "Settings: Management API keys",
};

export default async function ManagementApiKeysSettingsPage() {
  const keys = await loadManagementApiKeys();
  return <ManagementApiKeysPanel initial={keys} />;
}
