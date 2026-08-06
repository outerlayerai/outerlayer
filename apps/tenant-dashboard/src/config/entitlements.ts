/**
 * Tier catalog and entitlement registry.
 *
 * Numeric entitlement defaults live in @repo/tier-config (shared with gateway).
 * This file adds display metadata, boolean/categorical entitlements, and
 * service types consumed only by the dashboard.
 *
 * The `as const satisfies` pattern ensures:
 *   1. Literal types are preserved (enables derived union types).
 *   2. The compiler checks structural completeness (every tier, every key).
 *
 * To add a new gated feature, add a row to ENTITLEMENTS — no migration needed.
 */

import {
  type TierId as SharedTierId,
  TIER_IDS as SHARED_TIER_IDS,
  UNLIMITED as SHARED_UNLIMITED,
  NUMERIC_ENTITLEMENTS,
  BOOLEAN_ENTITLEMENTS,
} from '@repo/tier-config';

// Re-export shared types/values so existing consumers don't break
export type TierId = SharedTierId;
export const TIER_IDS = SHARED_TIER_IDS;
export const UNLIMITED = SHARED_UNLIMITED;


// ---------------------------------------------------------------------------
// Tier Catalog (display metadata — dashboard only)
// ---------------------------------------------------------------------------

interface TierConfig {
  displayName: string;
  sortOrder: number;
  isSelfServe: boolean;
  /** Matches `metadata.tier_id` on the Stripe Product. null = no Stripe product (free tier). */
  stripeProductMetadataKey: string | null;
  pricing: string | null;
}

export const TIERS = {
  hobby: {
    // Displayed as "Free" to users. The internal tier ID `hobby` is the value
    // stored in Stripe metadata, billing rows, and subscription history —
    // renaming it would require a data migration.
    displayName: 'Free',
    sortOrder: 0,
    isSelfServe: true,
    stripeProductMetadataKey: null,
    pricing: null,
  },
  growth: {
    displayName: 'Growth',
    sortOrder: 1,
    isSelfServe: true,
    stripeProductMetadataKey: 'growth',
    pricing: '$59/month',
  },
  team: {
    displayName: 'Team',
    sortOrder: 2,
    isSelfServe: true,
    stripeProductMetadataKey: 'team',
    pricing: '$499/month',
  },
  enterprise: {
    displayName: 'Enterprise',
    sortOrder: 3,
    isSelfServe: false,
    stripeProductMetadataKey: 'enterprise',
    pricing: null,
  },
} as const satisfies Record<TierId, TierConfig>;

// ---------------------------------------------------------------------------
// Entitlement Registry
// ---------------------------------------------------------------------------

interface BaseEntitlementDefinition {
  displayName: string;
}

interface NumericEntitlement extends BaseEntitlementDefinition {
  type: 'numeric';
  hobby: number;
  growth: number;
  team: number;
  enterprise: number;
}

interface BooleanEntitlement extends BaseEntitlementDefinition {
  type: 'boolean';
  hobby: boolean;
  growth: boolean;
  team: boolean;
  enterprise: boolean;
}

interface CategoricalEntitlement extends BaseEntitlementDefinition {
  type: 'categorical';
  hobby: string;
  growth: string;
  team: string;
  enterprise: string;
}

type EntitlementDefinition =
  | NumericEntitlement
  | BooleanEntitlement
  | CategoricalEntitlement;

type EntitlementRegistry = Record<string, EntitlementDefinition>;

export const ENTITLEMENTS = {
  // --- Numeric limits (-1 = unlimited) — values from @repo/tier-config ---

  /** Max number of apps a tenant can create. Pricing page: "Apps" row. */
  max_apps: { type: 'numeric', displayName: 'Multiple Apps', ...NUMERIC_ENTITLEMENTS.max_apps },
  /** Max active team members (non-disabled) per org. Pricing page: "Team members" row. */
  max_users: { type: 'numeric', displayName: 'Team Members', ...NUMERIC_ENTITLEMENTS.max_users },
  /** Max API keys across all apps. Pricing page: "API Keys" row. */
  max_api_keys: { type: 'numeric', displayName: 'API Keys', ...NUMERIC_ENTITLEMENTS.max_api_keys },
  /** Stripe-metered unit cap per billing period. Pricing page: "Units" row. */
  max_spans_per_month: { type: 'numeric', displayName: 'Units per Month', ...NUMERIC_ENTITLEMENTS.max_spans_per_month },
  /** CDN/prompt-fetch requests per month. Pricing page: "CDN Requests" row. */
  max_cdn_requests: { type: 'numeric', displayName: 'CDN Requests', ...NUMERIC_ENTITLEMENTS.max_cdn_requests },
  /** How long trace/analytics data is retained. Pricing page: "Data retention" row. */
  data_retention_days: { type: 'numeric', displayName: 'Data Retention', ...NUMERIC_ENTITLEMENTS.data_retention_days },
  /** Gateway API rate limit in requests per minute. Pricing page: "Higher Rate Limits" row. */
  rate_limit_rpm: { type: 'numeric', displayName: 'Rate Limit (RPM)', ...NUMERIC_ENTITLEMENTS.rate_limit_rpm },
  /** Max storage in GB per billing period. Pricing page: "Storage" row. */
  max_storage_gb_per_month: { type: 'numeric', displayName: 'Storage (GB/month)', ...NUMERIC_ENTITLEMENTS.max_storage_gb_per_month },
  /**
   * Tier caps: hobby=1 (dev only), growth=3, team=5,
   * enterprise=unlimited. Enforced at the env-create API; per-tenant
   * overrides via tenant_entitlement_override.
   */
  max_environments_per_app: { type: 'numeric', displayName: 'Environments per App', ...NUMERIC_ENTITLEMENTS.max_environments_per_app },
  /**
   * Concurrent cloud worker runs per tenant. Each run holds an
   * ephemeral machine, so concurrency is the cost lever. Enforced at the
   * worker launch API.
   */
  max_concurrent_worker_runs: { type: 'numeric', displayName: 'Concurrent Worker Runs', ...NUMERIC_ENTITLEMENTS.max_concurrent_worker_runs },
  /**
   * Cloud worker compute minutes per calendar month, metered
   * from worker_run.duration_ms. Enforced at the worker launch API.
   */
  max_worker_minutes_per_month: { type: 'numeric', displayName: 'Worker Minutes per Month', ...NUMERIC_ENTITLEMENTS.max_worker_minutes_per_month },
  /**
   * Max concurrent persistent worker environments per tenant.
   * Each holds a suspend/resumable sandbox — standing storage cost — so it's a
   * lower cap than one-shot runs. Enforced at persistent-environment create.
   */
  max_persistent_worker_environments: { type: 'numeric', displayName: 'Persistent Worker Environments', ...NUMERIC_ENTITLEMENTS.max_persistent_worker_environments },

  // --- Boolean features ---

  /** GitHub repository linking. Available on all tiers. */
  git_integration: { type: 'boolean', displayName: 'Git Integration', hobby: true, growth: true, team: true, enterprise: true },
  /** Distributed tracing for LLM calls. Available on all tiers. */
  traces_enabled: { type: 'boolean', displayName: 'Traces', hobby: true, growth: true, team: true, enterprise: true },
  /** Prompt versioning and management UI. Available on all tiers. */
  prompt_management: { type: 'boolean', displayName: 'Prompt Management', hobby: true, growth: true, team: true, enterprise: true },
  /** Test dataset management. Available on all tiers. */
  datasets_enabled: { type: 'boolean', displayName: 'Datasets', hobby: true, growth: true, team: true, enterprise: true },
  /** Session-based trace grouping. Available on all tiers. */
  sessions_enabled: { type: 'boolean', displayName: 'Sessions', hobby: true, growth: true, team: true, enterprise: true },
  /** Analytics dashboards. Available on all tiers. */
  metrics_dashboard: { type: 'boolean', displayName: 'Metrics Dashboard', hobby: true, growth: true, team: true, enterprise: true },
  /**
   * Ephemeral PR preview environments. A pull request that changes
   * previewable content auto-creates a throwaway env built off the PR branch.
   * Paid-only — each preview burns a Fly machine. Pricing page: "Preview
   * environments". Gated in the GitHub pull_request webhook handler.
   */
  preview_envs: { type: 'boolean', displayName: 'Preview Environments', hobby: false, growth: true, team: true, enterprise: true },
  /** Git branching workflow for prompt versioning. Pricing page: "Branching". */
  branching_workflow: { type: 'boolean', displayName: 'Branching Workflow', hobby: false, growth: false, team: false, enterprise: true },
  /** SAML/OIDC single sign-on. Pricing page: "SSO". */
  custom_sso: { type: 'boolean', displayName: 'Single Sign-On (SSO)', hobby: false, growth: false, team: true, enterprise: true },
  /** Per-app role assignments for granular access control. Enterprise only. */
  app_level_roles: { type: 'boolean', displayName: 'App-Level Roles', ...BOOLEAN_ENTITLEMENTS.app_level_roles },
  /** Custom metric creation and viewing. Pricing page: "Custom Metrics" row. */
  custom_metrics_enabled: { type: 'boolean', displayName: 'Custom Metrics', ...BOOLEAN_ENTITLEMENTS.custom_metrics_enabled },
  /** Custom role definitions beyond default roles. Pricing page: "Custom Roles" row. */
  custom_roles: { type: 'boolean', displayName: 'Custom Roles', ...BOOLEAN_ENTITLEMENTS.custom_roles },
  /**
   * Tenant-facing audit trail viewer + export (Settings -> Audit log).
   * Recording is always on for every org (the trail exists from day one, so
   * upgrading reveals history); only viewing/export is gated. Enterprise only.
   */
  audit_log: { type: 'boolean', displayName: 'Audit Log', hobby: false, growth: false, team: false, enterprise: true },
  /**
   * Cloud workers — terminal coding agents (Claude Code, Codex)
   * run against the app's connected repo on managed machines. Paid-only —
   * each run burns an ephemeral machine. Gated at the worker launch API.
   */
  workers_enabled: { type: 'boolean', displayName: 'Cloud Workers', ...BOOLEAN_ENTITLEMENTS.workers_enabled },
  /**
   * Persistent worker environments — a durable, suspend/
   * resumable workspace a worker can be continued in across turns (agent
   * session resumed, uncommitted state intact). Paid-only; standing storage.
   */
  persistent_worker_environments: { type: 'boolean', displayName: 'Persistent Worker Environments', ...BOOLEAN_ENTITLEMENTS.persistent_worker_environments },

  // --- Categorical ---

  /** Support channel. Values: 'community' (email + GitHub issues), 'dedicated' (Slack + SLA). */
  support_level: { type: 'categorical', displayName: 'Support Level', hobby: 'community', growth: 'community', team: 'dedicated', enterprise: 'dedicated' },
} as const satisfies EntitlementRegistry;

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type EntitlementKey = keyof typeof ENTITLEMENTS;

export type BooleanEntitlementKey = {
  [K in EntitlementKey]: (typeof ENTITLEMENTS)[K]['type'] extends 'boolean' ? K : never;
}[EntitlementKey];

export type NumericEntitlementKey = {
  [K in EntitlementKey]: (typeof ENTITLEMENTS)[K]['type'] extends 'numeric' ? K : never;
}[EntitlementKey];

// ---------------------------------------------------------------------------
// Service types (used by EntitlementService)
// ---------------------------------------------------------------------------

export type EntitlementCheckResult = {
  allowed: boolean;
  limit: number;
  currentCount: number;
  requiredTier?: TierId;
  upgradeUrl?: string;
};

export type ResolvedEntitlements = Record<EntitlementKey, boolean | number | string> & {
  tierId: TierId;
};

export type EntitlementDeniedInfo = {
  featureKey: EntitlementKey;
  featureDisplayName: string;
  requiredTier: TierId;
  requiredTierDisplayName: string;
  isSelfServe: boolean;
  pricing: string | null;
  upgradeUrl: string;
  currentLimit: number | null;
  requiredTierLimit: number | null;
};

export type TenantEntitlementOverride = {
  id: string;
  tenantId: string;
  entitlementKey: EntitlementKey;
  value: boolean | number | string;
  overrideReason: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type SetOverrideParams = {
  tenantId: string;
  key: EntitlementKey;
  value: boolean | number | string;
  reason: string;
  createdBy?: string;
};
