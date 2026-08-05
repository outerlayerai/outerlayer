/**
 * Tests for the entitlement config catalog.
 *
 * Guards business-critical pricing values and tier configuration.
 * Structural/shape validation is handled at compile time by TypeScript's
 * `as const satisfies EntitlementRegistry` — no need to re-test shapes here.
 */

import { TIERS, ENTITLEMENTS, TIER_IDS } from './entitlements';

// ---------------------------------------------------------------------------
// Tier configuration
// ---------------------------------------------------------------------------

describe('TIERS', () => {
  it('should order hobby before growth before team before enterprise', () => {
    expect(TIERS.hobby.sortOrder).toBeLessThan(TIERS.growth.sortOrder);
    expect(TIERS.growth.sortOrder).toBeLessThan(TIERS.team.sortOrder);
    expect(TIERS.team.sortOrder).toBeLessThan(TIERS.enterprise.sortOrder);
  });

  it('should mark hobby as self-serve', () => {
    expect(TIERS.hobby.isSelfServe).toBe(true);
  });

  it('should mark growth as self-serve', () => {
    expect(TIERS.growth.isSelfServe).toBe(true);
  });

  it('should mark team as self-serve', () => {
    expect(TIERS.team.isSelfServe).toBe(true);
  });

  it('should mark enterprise as non-self-serve', () => {
    expect(TIERS.enterprise.isSelfServe).toBe(false);
  });

  it('should expose all tier IDs in TIER_IDS', () => {
    expect([...TIER_IDS].sort()).toEqual(['enterprise', 'growth', 'hobby', 'team']);
  });
});

// ---------------------------------------------------------------------------
// Business-critical entitlement values
//
// These tests guard the exact numeric / boolean values that drive pricing,
// access control, and upgrade prompts. Changing any of these intentionally
// requires updating the corresponding test — that friction is the point.
// ---------------------------------------------------------------------------

describe('entitlement pricing values', () => {
  // ── App limits ──────────────────────────────────────────────────────

  it('should limit hobby to 1 app', () => {
    expect(ENTITLEMENTS.max_apps.hobby).toBe(1);
  });

  it('should limit growth to 3 apps', () => {
    expect(ENTITLEMENTS.max_apps.growth).toBe(3);
  });

  it('should give enterprise unlimited apps', () => {
    expect(ENTITLEMENTS.max_apps.enterprise).toBe(-1);
  });

  // ── User limits ─────────────────────────────────────────────────────

  it('should limit hobby to 2 team members', () => {
    expect(ENTITLEMENTS.max_users.hobby).toBe(2);
  });

  it('should give growth unlimited team members', () => {
    expect(ENTITLEMENTS.max_users.growth).toBe(-1);
  });

  it('should give enterprise unlimited team members', () => {
    expect(ENTITLEMENTS.max_users.enterprise).toBe(-1);
  });

  // ── API key limits ──────────────────────────────────────────────────

  it('should allow 25 API keys on hobby', () => {
    expect(ENTITLEMENTS.max_api_keys.hobby).toBe(25);
  });

  it('should allow 25 API keys on growth', () => {
    expect(ENTITLEMENTS.max_api_keys.growth).toBe(25);
  });

  it('should give enterprise unlimited API keys', () => {
    expect(ENTITLEMENTS.max_api_keys.enterprise).toBe(-1);
  });

  // ── Boolean features ────────────────────────────────────────────────

  it('should disable cloud workers on hobby', () => {
    expect(ENTITLEMENTS.workers_enabled.hobby).toBe(false);
  });

  it('should enable cloud workers on growth', () => {
    expect(ENTITLEMENTS.workers_enabled.growth).toBe(true);
  });

  it('restricts PR preview environments to paid tiers (growth+); free is off', () => {
    expect(ENTITLEMENTS.preview_envs.hobby).toBe(false);
    expect(ENTITLEMENTS.preview_envs.growth).toBe(true);
    expect(ENTITLEMENTS.preview_envs.team).toBe(true);
    expect(ENTITLEMENTS.preview_envs.enterprise).toBe(true);
  });

  it('should restrict branching workflow to enterprise', () => {
    expect(ENTITLEMENTS.branching_workflow.enterprise).toBe(true);
    expect(ENTITLEMENTS.branching_workflow.growth).toBe(false);
    expect(ENTITLEMENTS.branching_workflow.hobby).toBe(false);
  });

  it('should restrict SSO to team and enterprise', () => {
    expect(ENTITLEMENTS.custom_sso.enterprise).toBe(true);
    expect(ENTITLEMENTS.custom_sso.team).toBe(true);
    expect(ENTITLEMENTS.custom_sso.growth).toBe(false);
    expect(ENTITLEMENTS.custom_sso.hobby).toBe(false);
  });

  it('should enable custom roles on team tier and above', () => {
    expect(ENTITLEMENTS.custom_roles.team).toBe(true);
    expect(ENTITLEMENTS.custom_roles.enterprise).toBe(true);
    expect(ENTITLEMENTS.custom_roles.growth).toBe(false);
    expect(ENTITLEMENTS.custom_roles.hobby).toBe(false);
  });

  // ── Support levels ──────────────────────────────────────────────────

  it('should assign community support to hobby', () => {
    expect(ENTITLEMENTS.support_level.hobby).toBe('community');
  });

  it('should assign community support to growth', () => {
    expect(ENTITLEMENTS.support_level.growth).toBe('community');
  });

  it('should assign dedicated support to enterprise', () => {
    expect(ENTITLEMENTS.support_level.enterprise).toBe('dedicated');
  });

  // ── Cloud workers ────────────────────────────────────────────────────

  it('caps concurrent worker runs per tier (concurrency is the cost lever)', () => {
    expect(ENTITLEMENTS.max_concurrent_worker_runs.type).toBe('numeric');
    expect(ENTITLEMENTS.max_concurrent_worker_runs.displayName).toBe('Concurrent Worker Runs');
    expect(ENTITLEMENTS.max_concurrent_worker_runs.hobby).toBe(1);
    expect(ENTITLEMENTS.max_concurrent_worker_runs.growth).toBe(1);
    expect(ENTITLEMENTS.max_concurrent_worker_runs.team).toBe(3);
    expect(ENTITLEMENTS.max_concurrent_worker_runs.enterprise).toBe(10);
  });

  it('caps monthly worker compute minutes, unlimited only on enterprise', () => {
    expect(ENTITLEMENTS.max_worker_minutes_per_month.type).toBe('numeric');
    expect(ENTITLEMENTS.max_worker_minutes_per_month.displayName).toBe('Worker Minutes per Month');
    expect(ENTITLEMENTS.max_worker_minutes_per_month.hobby).toBe(60);
    expect(ENTITLEMENTS.max_worker_minutes_per_month.growth).toBe(300);
    expect(ENTITLEMENTS.max_worker_minutes_per_month.team).toBe(1200);
    expect(ENTITLEMENTS.max_worker_minutes_per_month.enterprise).toBe(-1);
  });

  it('caps persistent worker environments — 0 on free, unlimited on enterprise', () => {
    expect(ENTITLEMENTS.max_persistent_worker_environments.type).toBe('numeric');
    expect(ENTITLEMENTS.max_persistent_worker_environments.displayName).toBe('Persistent Worker Environments');
    expect(ENTITLEMENTS.max_persistent_worker_environments.hobby).toBe(0);
    expect(ENTITLEMENTS.max_persistent_worker_environments.growth).toBe(1);
    expect(ENTITLEMENTS.max_persistent_worker_environments.team).toBe(5);
    expect(ENTITLEMENTS.max_persistent_worker_environments.enterprise).toBe(-1);
  });

  it('gates cloud workers to paid tiers (free off)', () => {
    expect(ENTITLEMENTS.workers_enabled.type).toBe('boolean');
    expect(ENTITLEMENTS.workers_enabled.displayName).toBe('Cloud Workers');
    expect(ENTITLEMENTS.workers_enabled.hobby).toBe(false);
    expect(ENTITLEMENTS.workers_enabled.growth).toBe(true);
    expect(ENTITLEMENTS.workers_enabled.team).toBe(true);
    expect(ENTITLEMENTS.workers_enabled.enterprise).toBe(true);
  });

  it('gates persistent worker environments to paid tiers (free off)', () => {
    expect(ENTITLEMENTS.persistent_worker_environments.type).toBe('boolean');
    expect(ENTITLEMENTS.persistent_worker_environments.displayName).toBe('Persistent Worker Environments');
    expect(ENTITLEMENTS.persistent_worker_environments.hobby).toBe(false);
    expect(ENTITLEMENTS.persistent_worker_environments.growth).toBe(true);
    expect(ENTITLEMENTS.persistent_worker_environments.team).toBe(true);
    expect(ENTITLEMENTS.persistent_worker_environments.enterprise).toBe(true);
  });
});
