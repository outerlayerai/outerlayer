# Billing — Acceptance Criteria

Stripe-backed subscriptions, plan changes, webhook-driven billing state, and
the entitlements that billing tier gates.

Each criterion below carries a stable id. The test that proves a criterion
cites its id in a comment above the test, and
`scripts/ci/check-acceptance-coverage.mjs` enforces the join in both
directions — a criterion no test proves fails the build, and so does a test
citing a criterion that no longer exists.

Ids are written, never derived from position: a positional id silently
re-points at a different criterion the moment a scenario is inserted or
reordered, and the test keeps passing while proving the wrong thing. Never
renumber an id. Retire one by deleting the line and the citation together.

## Subscribing and changing plans

1. `AC-059-01` **Given** a tenant with billing enabled but no active subscription, **When** an authorized admin starts checkout for a tier from within an organization, **Then** the checkout session is created for that organization's Stripe customer and tenant id, never a different organization the admin also belongs to.
2. `AC-059-02` **Given** an active subscription, **When** an authorized admin changes tiers, **Then** the subscription's line items are swapped to the new tier's prices with proration.
3. `AC-059-03` **Given** a subscription scheduled to cancel at the end of the billing period, **When** the admin upgrades to another tier, **Then** the scheduled cancellation is lifted and the subscription continues on the new tier.
4. `AC-059-04` **Given** a subscription that has already been canceled, **When** an admin attempts to change its tier, **Then** the change is rejected instead of silently reactivating billing.
5. `AC-059-05` **Given** an organization with no Stripe customer yet (billing not enabled for it), **When** an admin requests checkout or the billing portal, **Then** the action fails with a clear "billing is not enabled" error instead of calling Stripe.

## Billing settings page

1. `AC-059-06` **Given** a tenant with an active subscription, **When** the billing settings page loads, **Then** it shows the current tier, this billing cycle's usage, and whether the subscription is set to cancel.
2. `AC-059-07` **Given** a tenant with no billing row (hobby/free), **When** the billing settings page loads, **Then** it shows zero usage and no tier rather than erroring.

## Stripe webhook-driven billing state

1. `AC-059-08` **Given** Stripe sends a subscription created or updated event for a known customer, **When** the webhook handler processes it, **Then** the tenant's stored tier is updated to match the subscription's price.
2. `AC-059-09` **Given** Stripe sends a subscription deleted event for the tenant's currently tracked subscription, **When** the webhook handler processes it, **Then** the tenant's tier resets to hobby and the subscription id is cleared.
3. `AC-059-10` **Given** a webhook payload arrives with an invalid or tampered signature, **When** the handler verifies it, **Then** the request is rejected with a 400 response and no billing data changes.
4. `AC-059-11` **Given** a subscription transitions to a non-paying status (canceled, unpaid, etc.), **When** the update webhook fires, **Then** the tenant's stored subscription id is cleared even though the tier keeps updating.

## Storage and usage entitlement enforcement

1. `AC-059-12` **Given** a tenant's metered storage usage exceeds their tier's cap (or an admin-set override), **When** the storage cap is checked, **Then** further storage-consuming writes are blocked; a tenant with an unlimited entitlement is never checked against Stripe at all.
2. `AC-059-13` **Given** the Stripe meter query fails while checking the storage cap, **When** the check runs, **Then** the tenant is allowed rather than blocked by an infrastructure failure.
3. `AC-059-14` **Given** an admin sets an entitlement override for a tenant, **When** any entitlement is resolved for that tenant, **Then** the override's value wins over the tier default, and an override of the wrong type (e.g. a boolean value on a numeric key) is ignored rather than silently coerced.

## Tenancy and permission scoping

1. `AC-059-15` **Given** an actor who holds only read access (or no access at all) to an organization, **When** they call any billing mutation under that organization, **Then** every one of them is denied with a billing-permission error, regardless of the role they hold in another organization. Billing reads are deliberately open to every role.

## Downgrade side effects

1. `AC-059-16` **Given** a tenant's tier changes from one that supports custom roles to one that doesn't, **When** the downgrade is applied, **Then** every membership's custom-role assignment is cleared and entitlement-gated permissions are scrubbed from the tenant's custom roles, while non-gated permissions are preserved.
