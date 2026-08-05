/**
 * OrganizationService - Business logic for organization management.
 * Service class with dependency injection so tests can supply their own deps.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  OrganizationServiceDeps,
  IStripeClient,
  IAuditLogService,
} from './types';
import type {
  ListOrganizationsParams,
  OrganizationListItem,
  OrganizationDetail,
  PaginatedResponse,
  DeleteOrganizationParams,
  DeleteOrganizationResult,
} from '../../../types/platform-admin';
import { sanitizeSearchTerm } from '../utils/sanitize-search';
import { TIERS, type TierId } from '../../../config/entitlements';

export class OrganizationService {
  private db: SupabaseClient;
  private stripe?: IStripeClient;
  private auditLog: IAuditLogService;

  constructor(deps: OrganizationServiceDeps) {
    this.db = deps.db;
    this.stripe = deps.stripe;
    this.auditLog = deps.auditLog;
  }

  /**
   * List all organizations with optional search and filters.
   */
  async list(
    params: ListOrganizationsParams
  ): Promise<{ data?: PaginatedResponse<OrganizationListItem>; error?: string }> {
    const {
      page = 1,
      pageSize = 25,
      search,
      createdAfter,
      createdBefore,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = params;

    const effectivePageSize = Math.min(pageSize, 100);
    const offset = (page - 1) * effectivePageSize;

    let query = this.db
      .from('tenant')
      .select(
        `
        tenant_id,
        company_name,
        organization_name,
        created_at,
        billing!left(stripe_subscription_id, tier_id)
      `,
        { count: 'exact' }
      );

    if (search) {
      const sanitized = sanitizeSearchTerm(search);
      query = query.or(
        `organization_name.ilike.%${sanitized}%,company_name.ilike.%${sanitized}%`
      );
    }

    if (createdAfter) {
      query = query.gte('created_at', createdAfter);
    }
    if (createdBefore) {
      query = query.lte('created_at', createdBefore);
    }

    if (sortBy === 'name') {
      query = query.order('organization_name', { ascending: sortOrder === 'asc' });
    } else if (sortBy === 'created_at') {
      query = query.order('created_at', { ascending: sortOrder === 'asc' });
    }

    query = query.range(offset, offset + effectivePageSize - 1);

    const { data: tenants, error, count } = await query;

    if (error) {
      return { error: `Failed to list organizations: ${error.message}` };
    }

    const tenantIds = tenants?.map((t) => t.tenant_id) || [];
    // Get user counts from membership table
    const { data: userCounts } = await this.db
      .from('membership')
      .select('tenant_id')
      .in('tenant_id', tenantIds)
      .eq('status', 'active')
      .neq('role', 'disabled');

    const countMap: Record<string, number> = {};
    userCounts?.forEach((uc) => {
      if (uc.tenant_id) {
        countMap[uc.tenant_id] = (countMap[uc.tenant_id] || 0) + 1;
      }
    });

    const items: OrganizationListItem[] = (tenants || []).map((t) => {
      // The join may return an array, get the first element
      const billingData = t.billing as unknown;
      const billing = (Array.isArray(billingData) ? billingData[0] : billingData) as { stripe_subscription_id: string | null; tier_id: string | null } | null;
      const tierId = (billing?.tier_id ?? 'hobby') as TierId;

      return {
        tenant_id: t.tenant_id,
        company_name: t.company_name,
        organization_name: t.organization_name,
        created_at: t.created_at || '',
        user_count: countMap[t.tenant_id] || 0,
        subscription_tier: TIERS[tierId]?.displayName ?? tierId,
        stripe_subscription_status: billing?.stripe_subscription_id ? 'active' : null,
      };
    });

    if (sortBy === 'user_count') {
      items.sort((a, b) => {
        const diff = a.user_count - b.user_count;
        return sortOrder === 'asc' ? diff : -diff;
      });
    }

    const total = count || 0;
    const totalPages = Math.ceil(total / effectivePageSize);

    return {
      data: {
        items,
        total,
        page,
        pageSize: effectivePageSize,
        totalPages,
      },
    };
  }

  /**
   * Get full details of a single organization.
   */
  async getDetail(
    tenantId: string
  ): Promise<{ data?: OrganizationDetail; error?: string }> {
    const { data: tenant, error: tenantError } = await this.db
      .from('tenant')
      .select(
        `
        tenant_id,
        company_name,
        organization_name,
        created_at,
        created_by
      `
      )
      .eq('tenant_id', tenantId)
      .single();

    if (tenantError || !tenant) {
      return { error: 'Organization not found' };
    }

    let createdBy: OrganizationDetail['created_by'] = null;
    if (tenant.created_by) {
      const { data: creator } = await this.db
        .from('profile')
        .select('id, email, name')
        .eq('id', tenant.created_by)
        .single();

      if (creator) {
        createdBy = {
          id: creator.id,
          email: creator.email,
          name: creator.name,
        };
      }
    }

    // Get users from membership table
    const { data: memberships } = await this.db
      .from('membership')
      .select(
        `
        role,
        user_id,
        created_at,
        profile:profile!membership_user_id_fkey(id, email, name)
      `
      )
      .eq('tenant_id', tenantId)
      .eq('status', 'active');

    const users: OrganizationDetail['users'] = (memberships || []).map((m) => {
      // The join may return an array, get the first element
      const profileData = m.profile as unknown;
      const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as { id: string; email: string; name: string | null } | null;
      return {
        id: profile?.id || '',
        email: profile?.email || '',
        name: profile?.name || null,
        role: m.role as 'owner' | 'admin' | 'write' | 'read' | 'disabled',
        joined_at: m.created_at || '',
      };
    });

    const { count: appsCount } = await this.db
      .from('app')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    const { count: apiKeysCount } = await this.db
      .from('api_key')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    const { data: billing } = await this.db
      .from('billing')
      .select('stripe_customer_id, stripe_subscription_id, tier_id')
      .eq('tenant_id', tenantId)
      .single();

    const { data: tempGrants } = await this.db
      .from('temp_access_grant')
      .select(
        `
        id,
        created_at,
        expires_at,
        created_by,
        profile:profile!temp_access_grant_created_by_fkey(email)
      `
      )
      .eq('tenant_id', tenantId)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString());

    const tempAccessGrants: OrganizationDetail['temp_access_grants'] = (
      tempGrants || []
    ).map((g) => {
      // The join may return an array, get the first element
      const profileData = g.profile as unknown;
      const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as { email: string } | null;
      return {
        id: g.id,
        admin_email: profile?.email || 'Unknown',
        created_at: g.created_at,
        expires_at: g.expires_at,
      };
    });

    // fly_app_name + fly_machine_id live on `environment`, not `app`. We keep
    // the platform-admin row shape (one row per app) by
    // sourcing those fields from the app's default env. Joining via the
    // existing environment.app_id FK + `is_default=true` filter gives exactly
    // one matching env row per app (idx_environment_one_default_per_app).
    const { data: appsRaw } = await this.db
      .from('app')
      .select(
        'id, name, runtime, environments:environment!environment_app_id_fkey(is_default, fly_app_name, fly_machine_id)',
      )
      .eq('tenant_id', tenantId)
      .order('name');

    type AppRowWithEnvs = {
      id: string;
      name: string;
      runtime: string | null;
      environments:
        | Array<{
            is_default: boolean;
            fly_app_name: string | null;
            fly_machine_id: string | null;
          }>
        | null;
    };

    const apps = (appsRaw ?? []) as unknown as AppRowWithEnvs[];

    // Only surface apps whose default env actually has a fly app provisioned.
    const managedApps = apps.flatMap((a) => {
      const defaultEnv = (a.environments ?? []).find((e) => e.is_default === true);
      if (!defaultEnv?.fly_app_name) return [];
      return [
        {
          id: a.id,
          name: a.name,
          runtime: a.runtime,
          fly_app_name: defaultEnv.fly_app_name,
          fly_machine_id: defaultEnv.fly_machine_id ?? null,
        },
      ];
    });

    // There is no `deployment` table (or code_status history) and nothing
    // can start a build, so no app will ever have a fresher status than
    // "No deployments". `latest_code_status` stays in the shape (rendered as
    // that fallback label) rather than reshaping the overview UI.
    const managedDeployments: OrganizationDetail['managed_deployments'] = managedApps.map((a) => ({
      app_id: a.id,
      app_name: a.name,
      runtime: a.runtime || 'nodejs',
      fly_app_name: a.fly_app_name,
      fly_machine_id: a.fly_machine_id,
      latest_code_status: null,
    }));

    return {
      data: {
        tenant_id: tenant.tenant_id,
        company_name: tenant.company_name,
        organization_name: tenant.organization_name,
        created_at: tenant.created_at || '',
        created_by: createdBy,
        users,
        apps_count: appsCount || 0,
        api_keys_count: apiKeysCount || 0,
        billing: billing
          ? {
              stripe_customer_id: billing.stripe_customer_id,
              stripe_subscription_id: billing.stripe_subscription_id,
              subscription_status: billing.stripe_subscription_id ? 'active' : null,
              tier_id: (billing.tier_id ?? 'hobby') as TierId,
              tier_display_name: TIERS[(billing.tier_id ?? 'hobby') as TierId]?.displayName ?? billing.tier_id,
            }
          : null,
        temp_access_grants: tempAccessGrants,
        managed_deployments: managedDeployments,
      },
    };
  }

  /**
   * Delete an organization and all its data.
   */
  async delete(
    params: DeleteOrganizationParams,
    adminUserId: string
  ): Promise<{ data?: DeleteOrganizationResult; error?: string }> {
    const { tenantId, confirmationName, reason } = params;

    // Step 1: Verify organization exists
    const { data: tenant, error: tenantError } = await this.db
      .from('tenant')
      .select('tenant_id, company_name, organization_name, created_at')
      .eq('tenant_id', tenantId)
      .single();

    if (tenantError || !tenant) {
      return { error: 'Organization not found' };
    }

    // Step 2: Validate confirmation name
    if (tenant.organization_name.toLowerCase() !== confirmationName.toLowerCase()) {
      return {
        error: `Confirmation name "${confirmationName}" does not match organization name "${tenant.organization_name}"`,
      };
    }

    // Step 3: Capture before_state for audit log
    const { data: memberships } = await this.db
      .from('membership')
      .select('user_id')
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .neq('role', 'disabled');

    const userCount = memberships?.length || 0;

    const { count: appsCount } = await this.db
      .from('app')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    const { count: apiKeysCount } = await this.db
      .from('api_key')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    const { data: billing } = await this.db
      .from('billing')
      .select('stripe_customer_id, stripe_subscription_id')
      .eq('tenant_id', tenantId)
      .single();

    const beforeState = {
      tenant_id: tenant.tenant_id,
      organization_name: tenant.organization_name,
      company_name: tenant.company_name,
      created_at: tenant.created_at,
      user_count: userCount,
      apps_count: appsCount || 0,
      api_keys_count: apiKeysCount || 0,
      stripe_customer_id: billing?.stripe_customer_id || null,
      stripe_subscription_id: billing?.stripe_subscription_id || null,
    };

    // Step 4: Count the tenant's API keys for the audit report. Must happen
    // before the delete, which takes the rows (and their
    // private.api_key_secret digests) with it. Deletion is revocation, so
    // there is no external key provider to sweep.
    const { count: apiKeyCountRaw } = await this.db
      .from('api_key')
      .select('api_key_id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId);

    const apiKeyCount = apiKeyCountRaw ?? 0;

    // Step 5: Delete the tenant. The git_connection rows (and any webhook_id
    // they carried) cascade-delete with it — only DB rows go away here.
    const { error: deleteError } = await this.db.rpc(
      'platform_admin_delete_tenant',
      { p_tenant_id: tenantId }
    );

    if (deleteError) {
      return { error: `Failed to delete organization: ${deleteError.message}` };
    }

    // Step 6: Cancel the Stripe subscription, after the delete has committed.
    // Order matters. Cancelling first means a failed delete leaves a customer
    // with no subscription and all their data, and no audit row to find it by.
    // This way the worst case is a live subscription for a deleted org, which
    // shows up in Stripe and is fixable by hand.
    let stripeSubscriptionCancelled = false;
    let stripeCancelError: string | null = null;
    if (billing?.stripe_subscription_id && this.stripe) {
      try {
        await this.stripe.subscriptions.cancel(billing.stripe_subscription_id);
        stripeSubscriptionCancelled = true;
      } catch (error) {
        stripeCancelError = error instanceof Error ? error.message : String(error);
        console.error('Failed to cancel Stripe subscription:', error);
      }
    }

    // Step 7: Create audit log. The tenant row is gone by now, so this is the
    // only record of the subscription id — beforeState carries it, which is
    // what an operator needs to cancel a leftover subscription by hand.
    await this.auditLog.create({
      actorId: adminUserId,
      actionType: 'org_delete',
      targetType: 'tenant',
      targetId: tenantId,
      targetIdentifier: tenant.organization_name,
      details: {
        reason: reason || null,
        stripe_subscription_cancelled: stripeSubscriptionCancelled,
        stripe_cancel_error: stripeCancelError,
        api_keys_revoked: apiKeyCount,
      },
      beforeState,
      afterState: null,
    });

    return {
      data: {
        deleted: true,
        stripeSubscriptionCancelled,
        apiKeyCount,
        userCount,
      },
    };
  }
}
