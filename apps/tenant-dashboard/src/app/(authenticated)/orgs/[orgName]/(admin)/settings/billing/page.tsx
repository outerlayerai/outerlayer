import { notFound } from "next/navigation";

import { resolveBillingConfig } from "@/lib/adapters";
import { BillingPage } from "@/features/billing";

import { BILLING_ENABLED } from "../../../../../../../config-global.server";

export const metadata = {
  title: "Settings: Billing",
};

export default function BillingSettingsPage() {
  // Billing disabled (self-hosting): the route doesn't exist. Guards direct-URL
  // access even though the nav tab is hidden.
  if (!resolveBillingConfig({ BILLING_ENABLED }).enabled) {
    notFound();
  }
  return <BillingPage />;
}
