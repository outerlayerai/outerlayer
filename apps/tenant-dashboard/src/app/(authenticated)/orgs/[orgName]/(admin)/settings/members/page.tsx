import { Suspense } from "react";
import { MembersView } from "./members-view";
import { listMembers, listAppsForInvite } from "@/features/members/service";
import { createSupabaseServerClient } from "../../../../../../../supabaseServerClient";
import { getEntitlement } from "@/lib/adapters";
import { getRequestTenantId } from "@/lib/tenant/request-tenant";
import { listCustomRoles } from "@ee/features/custom-roles/service";

export const metadata = {
  title: "Settings: Members",
};

export default async function MembersSettingsPage() {
  const requestTenantId = await getRequestTenantId();
  const supabase = await createSupabaseServerClient(requestTenantId);
  // The request tenant is the URL org the middleware derived.
  const tenantId = requestTenantId;

  let appLevelRolesEnabled = false;
  let customRolesEnabled = false;
  let customRoles: Array<{ id: string; name: string }> = [];
  let members: Awaited<ReturnType<typeof listMembers>> = [];
  let apps: Awaited<ReturnType<typeof listAppsForInvite>> = [];

  if (tenantId) {
    let customRolesResult: Awaited<ReturnType<typeof listCustomRoles>>;
    [appLevelRolesEnabled, customRolesEnabled, members, apps, customRolesResult] = await Promise.all([
      getEntitlement(tenantId, "app_level_roles"),
      getEntitlement(tenantId, "custom_roles"),
      listMembers(tenantId),
      listAppsForInvite(supabase),
      // Not gated on customRolesEnabled: the underlying read is RLS-scoped
      // only (no entitlement check), and the app-access dialog needs a
      // tenant's EXISTING custom-role assignments even when app_level_roles
      // and custom_roles have been overridden independently — a tenant can
      // hold one without the other (per-entitlement overrides, not just
      // tier grants) even though both default to the same value per tier.
      listCustomRoles(supabase, tenantId),
    ]);

    if (customRolesResult.success && customRolesResult.data) {
      customRoles = customRolesResult.data.map((r) => ({ id: r.id, name: r.name }));
    }
  }

  return (
    <Suspense>
      <MembersView
        users={members}
        appLevelRolesEnabled={appLevelRolesEnabled}
        customRolesEnabled={customRolesEnabled}
        customRoles={customRoles}
        apps={apps}
      />
    </Suspense>
  );
}
