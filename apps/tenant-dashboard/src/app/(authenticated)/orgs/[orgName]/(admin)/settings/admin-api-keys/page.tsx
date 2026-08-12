import { AdminApiKeysPanel } from "@/features/admin-api-keys";
import { loadAdminApiKeys } from "@/features/admin-api-keys/read";

export const metadata = {
  title: "Settings: Admin API keys",
};

export default async function AdminApiKeysSettingsPage() {
  const keys = await loadAdminApiKeys();
  return <AdminApiKeysPanel initial={keys} />;
}
