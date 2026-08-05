/**
 * FeatureFlagService - Business logic for feature flag management.
 * Service class with dependency injection for testability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IAuditLogService } from './types';
import type {
  FeatureFlagListItem,
  FeatureFlagDetail,
  FeatureFlagOverride,
  CreateFeatureFlagParams,
  UpdateFeatureFlagParams,
  SetFlagOverrideParams,
  RemoveFlagOverrideParams,
} from '../../../types/platform-admin';

interface FeatureFlagServiceDeps {
  db: SupabaseClient;
  auditLog: IAuditLogService;
}

export class FeatureFlagService {
  private db: SupabaseClient;
  private auditLog: IAuditLogService;

  constructor(deps: FeatureFlagServiceDeps) {
    this.db = deps.db;
    this.auditLog = deps.auditLog;
  }

  /**
   * List all feature flags with their settings and override counts.
   */
  async list(): Promise<{ data?: FeatureFlagListItem[]; error?: string }> {
    // Get all flags
    const { data: flags, error } = await this.db
      .from('feature_flag')
      .select(`
        id,
        key,
        description,
        is_enabled,
        strategy,
        rollout_percentage,
        created_at,
        updated_at
      `)
      .order('key', { ascending: true });

    if (error) {
      return { error: `Failed to list feature flags: ${error.message}` };
    }

    // Get override counts for each flag
    const flagIds = (flags || []).map((f) => f.id);
    let overrideCounts: Record<string, number> = {};

    if (flagIds.length > 0) {
      const { data: overrides } = await this.db
        .from('feature_flag_override')
        .select('flag_id')
        .in('flag_id', flagIds);

      // Count overrides per flag
      overrideCounts = (overrides || []).reduce((acc, o) => {
        acc[o.flag_id] = (acc[o.flag_id] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
    }

    const items: FeatureFlagListItem[] = (flags || []).map((f) => ({
      id: f.id,
      key: f.key,
      description: f.description,
      is_enabled: f.is_enabled,
      strategy: f.strategy || 'global',
      rollout_percentage: f.rollout_percentage || 0,
      override_count: overrideCounts[f.id] || 0,
      created_at: f.created_at,
      updated_at: f.updated_at,
    }));

    return { data: items };
  }

  /**
   * Get a feature flag with its overrides.
   */
  async getDetail(flagId: string): Promise<{ data?: FeatureFlagDetail; error?: string }> {
    const { data: flag, error: flagError } = await this.db
      .from('feature_flag')
      .select(`
        id,
        key,
        description,
        is_enabled,
        strategy,
        rollout_percentage,
        created_by,
        updated_by,
        created_at,
        updated_at
      `)
      .eq('id', flagId)
      .single();

    if (flagError || !flag) {
      return { error: 'Feature flag not found' };
    }

    // Fetch overrides
    const { data: overrides } = await this.db
      .from('feature_flag_override')
      .select('id, tenant_id, is_enabled, created_at')
      .eq('flag_id', flagId)
      .order('created_at', { ascending: false });

    // Get tenant names for overrides
    const tenantIds = (overrides || []).map((o) => o.tenant_id);
    let tenantMap: Record<string, string> = {};

    if (tenantIds.length > 0) {
      const { data: tenants } = await this.db
        .from('tenant')
        .select('tenant_id, organization_name')
        .in('tenant_id', tenantIds);

      tenantMap = (tenants || []).reduce(
        (acc, t) => ({ ...acc, [t.tenant_id]: t.organization_name }),
        {} as Record<string, string>
      );
    }

    const formattedOverrides: FeatureFlagOverride[] = (overrides || []).map((o) => ({
      id: o.id,
      tenant_id: o.tenant_id,
      organization_name: tenantMap[o.tenant_id] || o.tenant_id,
      is_enabled: o.is_enabled,
      created_at: o.created_at,
    }));

    return {
      data: {
        id: flag.id,
        key: flag.key,
        description: flag.description,
        is_enabled: flag.is_enabled,
        strategy: flag.strategy || 'global',
        rollout_percentage: flag.rollout_percentage || 0,
        created_at: flag.created_at,
        updated_at: flag.updated_at,
        created_by: flag.created_by,
        updated_by: flag.updated_by,
        overrides: formattedOverrides,
      },
    };
  }

  /**
   * Create a new feature flag.
   */
  async create(
    params: CreateFeatureFlagParams,
    adminUserId: string
  ): Promise<{ data?: { id: string; key: string }; error?: string }> {
    const { key, description, is_enabled = false, strategy = 'global', rollout_percentage = 0 } = params;

    // Validate key is unique
    const { data: existing } = await this.db
      .from('feature_flag')
      .select('id')
      .eq('key', key)
      .single();

    if (existing) {
      return { error: `Feature flag with key "${key}" already exists` };
    }

    // Validate rollout_percentage
    if (rollout_percentage < 0 || rollout_percentage > 100) {
      return { error: 'Rollout percentage must be between 0 and 100' };
    }

    // Insert the flag
    const { data: newFlag, error: insertError } = await this.db
      .from('feature_flag')
      .insert({
        key,
        description: description || null,
        is_enabled,
        strategy,
        rollout_percentage,
        created_by: adminUserId,
        created_at: new Date().toISOString(),
      })
      .select('id, key')
      .single();

    if (insertError || !newFlag) {
      return { error: `Failed to create feature flag: ${insertError?.message || 'Unknown error'}` };
    }

    // Create audit log
    await this.auditLog.create({
      actorId: adminUserId,
      actionType: 'flag_create',
      targetType: 'feature_flag',
      targetId: newFlag.id,
      targetIdentifier: key,
      details: { key, description, is_enabled, strategy, rollout_percentage },
      afterState: { key, description, is_enabled, strategy, rollout_percentage },
    });

    return { data: { id: newFlag.id, key: newFlag.key } };
  }

  /**
   * Update a feature flag's settings.
   */
  async update(
    params: UpdateFeatureFlagParams,
    adminUserId: string
  ): Promise<{ data?: { updated: true }; error?: string }> {
    const { flagId, is_enabled, strategy, rollout_percentage, description } = params;

    // Get current state for audit log
    const { data: currentFlag, error: getError } = await this.db
      .from('feature_flag')
      .select('*')
      .eq('id', flagId)
      .single();

    if (getError || !currentFlag) {
      return { error: 'Feature flag not found' };
    }

    // Validate rollout_percentage
    if (rollout_percentage !== undefined && (rollout_percentage < 0 || rollout_percentage > 100)) {
      return { error: 'Rollout percentage must be between 0 and 100' };
    }

    // Build update object
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      updated_by: adminUserId,
    };

    if (is_enabled !== undefined) updateData.is_enabled = is_enabled;
    if (strategy !== undefined) updateData.strategy = strategy;
    if (rollout_percentage !== undefined) updateData.rollout_percentage = rollout_percentage;
    if (description !== undefined) updateData.description = description;

    const { error: updateError } = await this.db
      .from('feature_flag')
      .update(updateData)
      .eq('id', flagId);

    if (updateError) {
      return { error: `Failed to update feature flag: ${updateError.message}` };
    }

    // Create audit log
    await this.auditLog.create({
      actorId: adminUserId,
      actionType: 'flag_update',
      targetType: 'feature_flag',
      targetId: flagId,
      targetIdentifier: currentFlag.key,
      details: { changes: updateData },
      beforeState: {
        is_enabled: currentFlag.is_enabled,
        strategy: currentFlag.strategy,
        rollout_percentage: currentFlag.rollout_percentage,
        description: currentFlag.description,
      },
      afterState: {
        is_enabled: is_enabled ?? currentFlag.is_enabled,
        strategy: strategy ?? currentFlag.strategy,
        rollout_percentage: rollout_percentage ?? currentFlag.rollout_percentage,
        description: description ?? currentFlag.description,
      },
    });

    return { data: { updated: true } };
  }

  /**
   * Delete a feature flag (overrides are cascade-deleted).
   */
  async delete(
    flagId: string,
    adminUserId: string
  ): Promise<{ data?: { deleted: true }; error?: string }> {
    // Get flag for audit log
    const { data: flag, error: getError } = await this.db
      .from('feature_flag')
      .select('*')
      .eq('id', flagId)
      .single();

    if (getError || !flag) {
      return { error: 'Feature flag not found' };
    }

    // Get override count for audit
    const { count: overrideCount } = await this.db
      .from('feature_flag_override')
      .select('*', { count: 'exact', head: true })
      .eq('flag_id', flagId);

    // Delete the flag (overrides cascade automatically)
    const { error: deleteError } = await this.db
      .from('feature_flag')
      .delete()
      .eq('id', flagId);

    if (deleteError) {
      return { error: `Failed to delete feature flag: ${deleteError.message}` };
    }

    // Create audit log
    await this.auditLog.create({
      actorId: adminUserId,
      actionType: 'flag_delete',
      targetType: 'feature_flag',
      targetId: flagId,
      targetIdentifier: flag.key,
      details: { overrides_deleted: overrideCount || 0 },
      beforeState: {
        key: flag.key,
        description: flag.description,
        is_enabled: flag.is_enabled,
        strategy: flag.strategy,
        rollout_percentage: flag.rollout_percentage,
      },
    });

    return { data: { deleted: true } };
  }

  /**
   * Set an override for a specific tenant (create or update).
   */
  async setOverride(
    params: SetFlagOverrideParams,
    adminUserId: string
  ): Promise<{ data?: { set: true }; error?: string }> {
    const { flagId, tenantId, isEnabled } = params;

    // Verify flag exists
    const { data: flag, error: flagError } = await this.db
      .from('feature_flag')
      .select('key')
      .eq('id', flagId)
      .single();

    if (flagError || !flag) {
      return { error: 'Feature flag not found' };
    }

    // Verify tenant exists
    const { data: tenant, error: tenantError } = await this.db
      .from('tenant')
      .select('organization_name')
      .eq('tenant_id', tenantId)
      .single();

    if (tenantError || !tenant) {
      return { error: 'Organization not found' };
    }

    // Check if override already exists
    const { data: existingOverride } = await this.db
      .from('feature_flag_override')
      .select('id, is_enabled')
      .eq('flag_id', flagId)
      .eq('tenant_id', tenantId)
      .single();

    if (existingOverride) {
      // Update existing override
      const { error: updateError } = await this.db
        .from('feature_flag_override')
        .update({ is_enabled: isEnabled })
        .eq('id', existingOverride.id);

      if (updateError) {
        return { error: `Failed to update override: ${updateError.message}` };
      }

      await this.auditLog.create({
        actorId: adminUserId,
        actionType: 'flag_targeting_update',
        targetType: 'feature_flag',
        targetId: flagId,
        targetIdentifier: flag.key,
        details: {
          action: 'update_override',
          tenant_id: tenantId,
          organization_name: tenant.organization_name,
          is_enabled: isEnabled,
        },
        beforeState: { is_enabled: existingOverride.is_enabled },
        afterState: { is_enabled: isEnabled },
      });
    } else {
      // Create new override
      const { error: insertError } = await this.db
        .from('feature_flag_override')
        .insert({
          flag_id: flagId,
          tenant_id: tenantId,
          is_enabled: isEnabled,
          created_by: adminUserId,
          created_at: new Date().toISOString(),
        });

      if (insertError) {
        return { error: `Failed to create override: ${insertError.message}` };
      }

      await this.auditLog.create({
        actorId: adminUserId,
        actionType: 'flag_targeting_update',
        targetType: 'feature_flag',
        targetId: flagId,
        targetIdentifier: flag.key,
        details: {
          action: 'set_override',
          tenant_id: tenantId,
          organization_name: tenant.organization_name,
          is_enabled: isEnabled,
        },
      });
    }

    return { data: { set: true } };
  }

  /**
   * Remove an override for a specific tenant.
   */
  async removeOverride(
    params: RemoveFlagOverrideParams,
    adminUserId: string
  ): Promise<{ data?: { removed: true }; error?: string }> {
    const { flagId, tenantId } = params;

    // Verify flag exists
    const { data: flag, error: flagError } = await this.db
      .from('feature_flag')
      .select('key')
      .eq('id', flagId)
      .single();

    if (flagError || !flag) {
      return { error: 'Feature flag not found' };
    }

    // Check override exists
    const { data: existingOverride } = await this.db
      .from('feature_flag_override')
      .select('id, is_enabled')
      .eq('flag_id', flagId)
      .eq('tenant_id', tenantId)
      .single();

    if (!existingOverride) {
      return { error: 'Override not found for this organization' };
    }

    // Get tenant name for audit
    const { data: tenant } = await this.db
      .from('tenant')
      .select('organization_name')
      .eq('tenant_id', tenantId)
      .single();

    // Delete the override
    const { error: deleteError } = await this.db
      .from('feature_flag_override')
      .delete()
      .eq('id', existingOverride.id);

    if (deleteError) {
      return { error: `Failed to remove override: ${deleteError.message}` };
    }

    await this.auditLog.create({
      actorId: adminUserId,
      actionType: 'flag_targeting_update',
      targetType: 'feature_flag',
      targetId: flagId,
      targetIdentifier: flag.key,
      details: {
        action: 'remove_override',
        tenant_id: tenantId,
        organization_name: tenant?.organization_name || tenantId,
      },
      beforeState: { is_enabled: existingOverride.is_enabled },
    });

    return { data: { removed: true } };
  }

  /**
   * Evaluate if a flag is enabled for a specific tenant.
   * Checks override table first, then falls back to global flag state.
   */
  async isEnabled(flagKey: string, tenantId?: string): Promise<boolean> {
    // Get flag
    const { data: flag } = await this.db
      .from('feature_flag')
      .select('id, is_enabled, strategy, rollout_percentage')
      .eq('key', flagKey)
      .single();

    if (!flag) {
      return false; // Flag doesn't exist, default to disabled
    }

    // If flag is globally disabled, return false
    if (!flag.is_enabled) {
      return false;
    }

    // Check for tenant-specific override
    if (tenantId) {
      const { data: override } = await this.db
        .from('feature_flag_override')
        .select('is_enabled')
        .eq('flag_id', flag.id)
        .eq('tenant_id', tenantId)
        .single();

      if (override) {
        return override.is_enabled;
      }
    }

    // Apply strategy
    switch (flag.strategy) {
      case 'global':
        return true; // Flag is enabled for everyone

      case 'percentage':
        if (tenantId) {
          // Hash-based deterministic rollout
          const hash = Array.from(tenantId + flag.rollout_percentage.toString()).reduce(
            (acc, char) => ((acc << 5) - acc + char.charCodeAt(0)) & 0xffffffff,
            0
          );
          const tenantPercentage = Math.abs(hash) % 100;
          return tenantPercentage < (flag.rollout_percentage || 0);
        }
        return false;

      case 'targeted':
        // Targeted strategy: only tenants with overrides (is_enabled=true) get the feature
        // Since we already checked overrides above and didn't find one, return false
        return false;

      default:
        return false;
    }
  }
}
