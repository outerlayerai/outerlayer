// Imported by path, not the feature barrel: `OrganizationForm` is a "use
// client" component and `loadOrgSettings` guards itself with `server-only` —
// re-exporting both from one index risks a client bundle pulling in the
// server-only module through the shared module graph.
import { OrganizationForm } from "@/features/org-settings/components/organization-form";
import { loadOrgSettings } from "@/features/org-settings/read";

export const metadata = {
  title: "Settings: General",
};

export default async function GeneralSettingsPage() {
  const org = await loadOrgSettings();
  return <OrganizationForm org={org} />;
}
