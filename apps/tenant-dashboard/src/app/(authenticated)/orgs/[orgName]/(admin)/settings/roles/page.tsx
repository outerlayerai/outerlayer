import { Suspense } from "react";
import { CustomRolesList } from "@ee/features/custom-roles/components/custom-roles-list";
import { listCustomRoles } from "@ee/features/custom-roles/service";
import { createSupabaseServerClient } from "../../../../../../../supabaseServerClient";
import { createSupabaseAdminClient } from "../../../../../../../supabaseAdminClient";
import { EntitlementService } from "@/lib/system/entitlement-service";
import { getRequestTenantId } from "@/lib/tenant/request-tenant";
import { ENTITLEMENTS } from "../../../../../../../config/entitlements";

export const metadata = {
  title: "Settings: Roles",
};

export default async function RolesSettingsPage() {
  const requestTenantId = await getRequestTenantId();
  const supabase = await createSupabaseServerClient(requestTenantId);
  // The request tenant is the URL org the middleware derived.
  const tenantId = requestTenantId;

  let customRolesEnabled = false;
  let initialRoles = undefined;
  let activeEntitlements: string[] = [];

  if (tenantId) {
    const supabaseAdmin = createSupabaseAdminClient();
    const entitlementService = new EntitlementService({ db: supabaseAdmin });

    const [resolved] = await Promise.all([
      entitlementService.getEffectiveEntitlements(tenantId),
    ]);

    customRolesEnabled = resolved.custom_roles as boolean;

    // Collect all boolean entitlement keys that are active (true) for the tenant.
    // This drives which permission groups are shown in the PermissionPicker.
    activeEntitlements = (Object.keys(ENTITLEMENTS) as Array<keyof typeof ENTITLEMENTS>).filter(
      (key) => ENTITLEMENTS[key].type === "boolean" && resolved[key] === true,
    );

    if (customRolesEnabled) {
      const result = await listCustomRoles(supabase, tenantId);
      if (result.success && result.data) {
        initialRoles = result.data;
      }
    }
  }

  return (
    <Suspense>
      <CustomRolesList
        customRolesEnabled={customRolesEnabled}
        initialRoles={initialRoles}
        activeEntitlements={activeEntitlements}
      />
    </Suspense>
  );
}
