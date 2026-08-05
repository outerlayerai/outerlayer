import "server-only";

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClickHouseClient } from '@clickhouse/client';
import { ENTITLEMENTS, UNLIMITED } from '@/config/entitlements';
import { NotificationTypes } from '@/utils/notifications';

export interface SpanUsageNotificationDeps {
  supabase: SupabaseClient;
  clickhouse: ClickHouseClient | null;
}

// eslint-disable-next-line import/no-unused-modules -- used by cron route and tests
export interface NotificationResult {
  processed: number;
  notified: { tenantId: string; threshold: 80 | 100 }[];
  skipped: number;
  errors: { tenantId: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DEFAULT_HOBBY_LIMIT = ENTITLEMENTS.max_spans_per_month.hobby;

export class SpanUsageNotificationService {
  constructor(private deps: SpanUsageNotificationDeps) {}

  async checkAndNotify(): Promise<NotificationResult> {
    const result: NotificationResult = {
      processed: 0,
      notified: [],
      skipped: 0,
      errors: [],
    };

    if (!this.deps.clickhouse) {
      result.errors.push({ tenantId: '*', error: 'ClickHouse client not available' });
      return result;
    }

    // 1. Fetch hobby-tier tenant IDs
    const { data: hobbyTenants, error: billingError } = await this.deps.supabase
      .from('billing')
      .select('tenant_id')
      .eq('tier_id', 'hobby');

    if (billingError) {
      result.errors.push({ tenantId: '*', error: `Billing query failed: ${billingError.message}` });
      return result;
    }

    if (!hobbyTenants || hobbyTenants.length === 0) {
      return result;
    }

    const tenantIds = hobbyTenants.map((t) => t.tenant_id as string);
    result.processed = tenantIds.length;

    // 2. Fetch entitlement overrides for these tenants
    const { data: overrides } = await this.deps.supabase
      .from('tenant_entitlement_override')
      .select('tenant_id,value')
      .in('tenant_id', tenantIds)
      .eq('entitlement_key', 'max_spans_per_month');

    const overrideMap = new Map<string, number>();
    if (overrides) {
      for (const o of overrides) {
        const rawV = (o.value as { v: unknown }).v;
        if (rawV !== null && rawV !== undefined) {
          const parsed = Number(rawV);
          if (!Number.isNaN(parsed)) {
            overrideMap.set(o.tenant_id, parsed);
          }
        }
      }
    }

    // 3. Batch ClickHouse count — current calendar month
    let spanCounts: Map<string, number>;
    try {
      const chResult = await this.deps.clickhouse.query({
        query: `SELECT TenantId, COUNT(*) AS count FROM otel_traces WHERE TenantId IN ({tenantIds:Array(String)}) AND toYYYYMM(CreatedAt) = toYYYYMM(now()) GROUP BY TenantId`,
        query_params: { tenantIds },
        format: 'JSONEachRow',
      });
      const rows = await chResult.json<{ TenantId: string; count: string }>();
      spanCounts = new Map(rows.map((r) => [r.TenantId, Number(r.count)]));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ tenantId: '*', error: `ClickHouse query failed: ${message}` });
      return result;
    }

    // 4. Fetch existing notifications this month (dedup check)
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const { data: existingNotifications } = await this.deps.supabase
      .from('notification')
      .select('tenant_id,message')
      .in('tenant_id', tenantIds)
      .gte('created_at', monthStart.toISOString())
      .like('message', 'You have used%of your free units.');

    const existingSet = new Set<string>();
    if (existingNotifications) {
      for (const n of existingNotifications) {
        // Key: "tenant_id:threshold"
        if (n.message.includes('80%')) {
          existingSet.add(`${n.tenant_id}:80`);
        }
        if (n.message.includes('100%')) {
          existingSet.add(`${n.tenant_id}:100`);
        }
      }
    }

    // 5. Process each tenant
    for (const tenantId of tenantIds) {
      const limit = overrideMap.get(tenantId) ?? DEFAULT_HOBBY_LIMIT;

      // Unlimited override → skip
      if (limit === UNLIMITED) {
        result.skipped++;
        continue;
      }

      const count = spanCounts.get(tenantId) ?? 0;
      const percentUsed = limit > 0 ? (count / limit) * 100 : 0;

      // Determine which notification to send (highest applicable, deduplicated)
      let threshold: 80 | 100 | null = null;

      if (percentUsed >= 100 && !existingSet.has(`${tenantId}:100`)) {
        threshold = 100;
      } else if (percentUsed >= 80 && percentUsed < 100 && !existingSet.has(`${tenantId}:80`)) {
        threshold = 80;
      }

      if (!threshold) {
        result.skipped++;
        continue;
      }

      const message = `You have used ${threshold}% of your free units.`;

      const { error: insertError } = await this.deps.supabase.from('notification').insert({
        tenant_id: tenantId,
        message,
        type: NotificationTypes.Warning,
      });

      if (insertError) {
        result.errors.push({ tenantId, error: `Insert failed: ${insertError.message}` });
      } else {
        result.notified.push({ tenantId, threshold });
      }
    }

    return result;
  }
}
