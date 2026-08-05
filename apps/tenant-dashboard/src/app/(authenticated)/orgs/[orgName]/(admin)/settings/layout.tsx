import { isSelfHostDeployment } from "@repo/ee-license";

import { createSupabaseServerClient } from "../../../../../../supabaseServerClient";
import { getEntitlement } from "@/lib/adapters";
import { getRequestTenantId } from "@/lib/tenant/request-tenant";
import { resolveBillingConfig } from "../../../../../../lib/external-services/billing-config";
import { BILLING_ENABLED } from "../../../../../../config-global.server";
import { SettingsShell } from "@/components/settings-shell";
import { SettingsNav } from "./settings-nav";

type Props = {
  children: React.ReactNode;
  params: Promise<{ orgName: string }>;
};

export default async function SettingsLayout({ children, params }: Props) {
  const { orgName } = await params;

  let showSsoTab = false;
  let showRolesTab = false;
  let showAuditLogTab = false;
  let showAiCostsTab = false;
  const showBillingTab = resolveBillingConfig({ BILLING_ENABLED }).enabled;
  // The License tab is a self-host-only surface (licensed org, plan, expiry).
  // Cloud never sets OUTERLAYER_SELF_HOSTED, so the tab — and the page behind
  // it (notFound on Cloud) — stay hidden there.
  const showLicenseTab = isSelfHostDeployment();
  const requestTenantId = await getRequestTenantId();
  const supabase = await createSupabaseServerClient(requestTenantId);
  const { error: getUserError } = await supabase.auth.getUser();

  if (getUserError) {
    console.error("[SettingsLayout] Failed to get user for entitlement check:", getUserError);
  }

  // The request tenant is the URL org the middleware derived — every gate
  // below answers for the org actually on screen.
  const tenantId = requestTenantId;

  if (tenantId) {
    // The audit log tab is double-gated: the org needs the Enterprise
    // audit_log entitlement AND the caller needs audit_log.read (owner/admin
    // built-in, custom roles by opt-in — authorize() evaluates the caller's
    // own JWT). The server actions re-check both on every request.
    const [ssoAccess, rolesAccess, auditEntitled, auditRead, aiCostRead] = await Promise.all([
      getEntitlement(tenantId, "custom_sso"),
      getEntitlement(tenantId, "custom_roles"),
      getEntitlement(tenantId, "audit_log"),
      supabase.rpc("authorize", { requested_permission: "audit_log.read" }),
      supabase.rpc("authorize", { requested_permission: "ai_cost_config.read" }),
    ]);
    showSsoTab = ssoAccess;
    showRolesTab = rolesAccess;
    showAuditLogTab = auditEntitled && auditRead.data === true;
    // Owner/admin only (12-rbac seeds) — org-level financial configuration.
    showAiCostsTab = aiCostRead.data === true;
  }

  return (
    <SettingsShell
      heading="Organization settings"
      nav={
        <SettingsNav
          orgName={orgName}
          showRolesTab={showRolesTab}
          showSsoTab={showSsoTab}
          showBillingTab={showBillingTab}
          showAuditLogTab={showAuditLogTab}
          showLicenseTab={showLicenseTab}
          showAiCostsTab={showAiCostsTab}
        />
      }
    >
      {children}
    </SettingsShell>
  );
}
