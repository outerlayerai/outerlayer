import { PageSkeleton } from "@/components/page-skeleton";

/**
 * The billing page's React Server Component (RSC) read blocks on up to three sequential Stripe
 * round-trips (subscription retrieve, then two meter-summary reads) plus the
 * `billing` table read — without this boundary the settings tab stays blank
 * for that whole chain. `header={false}`: the settings layout already
 * renders the nav and the page's own section chrome.
 */
export default function BillingLoading() {
  return <PageSkeleton variant="settings-form" header={false} data-testid="billing-loading" />;
}
