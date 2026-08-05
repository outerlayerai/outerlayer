import { Alert } from "@mui/material";

import { SettingsSection } from "@/components/settings-shell";
import { TIERS, type TierId } from "@/config/entitlements";

import { loadBillingPageState } from "../read";
import BillingSetup from "./billing-setup";
import BillingManagement from "./billing-management";

// SettingsSection's description is presentational copy, not user data — this
// Server Component can't reach the client-only useTranslate() hook, and the
// dashboard ships a single locale today (src/locales/langs/en.json), so the
// string is inlined rather than routed through i18n at this one layer.
const BILLING_DESCRIPTION = "Easily manage or start your subscription.";

/**
 * The billing settings page. `loadBillingPageState` runs the gated
 * `billing.read` action server-side, so a caller without the permission
 * sees a denial rather than the page rendering with zeroed-out usage.
 */
export default async function BillingPage() {
  const result = await loadBillingPageState();

  if (!result.ok) {
    return (
      <SettingsSection description={BILLING_DESCRIPTION}>
        <Alert severity="error">{result.error}</Alert>
      </SettingsSection>
    );
  }

  const { units, storageGb, isCancelling, tierId } = result.data;

  const rawTierId = tierId ?? undefined;
  const isBillingCustomer = !!rawTierId && rawTierId !== "hobby" && rawTierId in TIERS;
  const resolvedTierId: TierId = isBillingCustomer ? (rawTierId as TierId) : "hobby";
  const tierDisplayName = TIERS[resolvedTierId].displayName;

  return (
    <SettingsSection description={BILLING_DESCRIPTION}>
      {isBillingCustomer ? (
        <BillingManagement
          usage={units}
          storageGb={storageGb}
          tierId={resolvedTierId}
          tierDisplayName={tierDisplayName}
          isCancelling={isCancelling}
        />
      ) : (
        <BillingSetup usage={units} storageGb={storageGb} />
      )}
    </SettingsSection>
  );
}
