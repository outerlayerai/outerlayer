// ---------------------------------------------------------------------------
// DORA Metrics - Data Collection Service
//
// Collects incident data from BetterStack, normalizes it, stores it in the
// platform_incident table, and correlates incidents with deployments for
// change-failure-rate attribution.
//
// Deployment events are NOT collected here. The CD pipeline pushes them
// directly to /api/internal/dora/deployments at deploy time. Pulling them from
// the GitHub API instead means reconstructing deploy events from job names +
// regexes, which is lossy: one job's conclusion gets attributed to every
// service it deployed, and its timestamps race the push path's. CI is closest
// to the event; CI is the source of truth.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/db';

import { mapMonitorToEnvironment, mapMonitorToService } from './monitor-service-map';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BETTERSTACK_API_BASE = 'https://uptime.betterstack.com/api/v3';
const INCIDENT_CORRELATION_WINDOW_MS = 60 * 60 * 1000; // 60 minutes
/** How far back each run re-attempts correlation for uncorrelated incidents.
 *  Deployments can arrive after their incident (CD push lands on its own
 *  schedule), so every run retries recent NULL-deployment_id incidents. */
const CORRELATION_LOOKBACK_DAYS = 14;
const BETTERSTACK_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Types for external API responses
// ---------------------------------------------------------------------------

interface BetterStackIncident {
  id: string;
  type: string;
  attributes: {
    name: string;
    url: string | null;
    cause: string | null;
    status: string;
    started_at: string;
    acknowledged_at: string | null;
    resolved_at: string | null;
  };
}

interface BetterStackApiResponse {
  data: BetterStackIncident[];
  pagination: {
    next: string | null;
  };
}

// ---------------------------------------------------------------------------
// Collection Options & Result
// ---------------------------------------------------------------------------

export interface CollectionOptions {
  backfill: boolean;
  backfillMonths?: number;
}

export interface CollectionResult {
  betterstack_incidents: { collected: number; errors: string[] };
  /** False when ANY error occurred. Callers must treat ok=false as failure —
   *  per-source error swallowing is how the previous design ran silently
   *  broken for 15 weeks. */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// DoraCollectionService
// ---------------------------------------------------------------------------

export class DoraCollectionService {
  /**
   * @param environment The deployment environment THIS instance collects
   *   for. BetterStack monitors cover all environments; each store keeps
   *   only its own environment's incidents — the pull itself is
   *   environment-driven, not just the read.
   */
  constructor(
    private readonly supabase: SupabaseClient<Database>,
    private readonly betterStackToken: string,
    private readonly environment: 'production' | 'staging',
  ) {}

  // =========================================================================
  // Public: Run collection
  // =========================================================================

  async runCollection(options: CollectionOptions): Promise<CollectionResult> {
    const result: CollectionResult = {
      betterstack_incidents: { collected: 0, errors: [] },
      ok: true,
    };

    const since = this.computeSinceDate(options);

    try {
      result.betterstack_incidents.collected =
        await this.collectBetterStackIncidents(since);
      await this.correlateIncidents();
      // Only terminal states are recorded — an intermediate 'running' state
      // would stick forever if the function died mid-run.
      await this.updateCollectionState('betterstack_incidents', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.betterstack_incidents.errors.push(msg);
      result.ok = false;
      await this.updateCollectionState('betterstack_incidents', 'error', msg);
    }

    return result;
  }

  // =========================================================================
  // BetterStack Incidents Collection
  // =========================================================================

  async collectBetterStackIncidents(since: Date): Promise<number> {
    let collected = 0;
    let nextUrl: string | null =
      `${BETTERSTACK_API_BASE}/incidents?per_page=${BETTERSTACK_PAGE_SIZE}&from=${since.toISOString().split('T')[0]}`;

    while (nextUrl) {
      const response = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${this.betterStackToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`BetterStack API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as BetterStackApiResponse;

      for (const incident of data.data) {
        const upserted = await this.upsertIncident(incident);
        if (upserted) collected++;
      }

      nextUrl = data.pagination?.next ?? null;
    }

    return collected;
  }

  private async upsertIncident(incident: BetterStackIncident): Promise<boolean> {
    const attrs = incident.attributes;
    // URL host is authoritative for BOTH service and environment — segment by
    // the monitored URL's hostname (name keywords as fallback) so e.g.
    // "Analytics API" (app.agentmark.co/api/analytics) maps to tenant-dashboard
    // not gateway, and staging incidents never pollute production MTTR/CFR.
    const service = mapMonitorToService(attrs.name ?? '', attrs.url ?? null);
    const environment = mapMonitorToEnvironment(attrs.name ?? '', attrs.url ?? null);

    // This store only keeps ITS environment's incidents. Unmappable
    // monitors are skipped too (with the mapper's warning) — better
    // uncounted than miscounted.
    if (environment !== this.environment) {
      return false;
    }

    let resolutionMs: number | null = null;
    if (attrs.resolved_at && attrs.started_at) {
      resolutionMs = new Date(attrs.resolved_at).getTime() - new Date(attrs.started_at).getTime();
    }

    // Map BetterStack status to our normalized status. Keys are lowercased —
    // the v3 API documents Pascal case ("Started", "Resolved") but an
    // unexpected casing must not silently demote a resolved incident.
    const statusMap: Record<string, string> = {
      started: 'started',
      unconfirmed: 'started',
      validating: 'started',
      acknowledged: 'acknowledged',
      resolved: 'resolved',
    };
    const normalizedStatus = statusMap[(attrs.status ?? '').toLowerCase()];
    if (!normalizedStatus) {
      console.warn(
        `[dora-collection] Unknown BetterStack incident status "${attrs.status}" for incident ${incident.id} — defaulting to 'started'`,
      );
    }

    const row = {
      external_id: incident.id,
      source: 'betterstack',
      monitor_name: attrs.name ?? null,
      service,
      environment,
      severity: null,
      cause: attrs.cause ?? null,
      status: normalizedStatus ?? 'started',
      url: attrs.url ?? null,
      started_at: attrs.started_at,
      acknowledged_at: attrs.acknowledged_at ?? null,
      resolved_at: attrs.resolved_at ?? null,
      resolution_ms: resolutionMs,
    };

    // Upsert: try insert, on conflict update
    const { error: insertError } = await this.supabase
      .from('platform_incident')
      .upsert(row, { onConflict: 'external_id' });

    if (insertError) {
      console.error(`[dora-collection] Incident upsert failed: ${insertError.message}`);
      return false;
    }

    return true;
  }

  // =========================================================================
  // Incident-Deployment Correlation
  // =========================================================================

  async correlateIncidents(): Promise<number> {
    // Find uncorrelated incidents within the lookback window. Re-running for
    // NULL deployment_id rows every collection tick means a deployment that
    // arrived after its incident still gets correlated on a later run.
    const lookbackStart = new Date(
      Date.now() - CORRELATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: incidents, error } = await this.supabase
      .from('platform_incident')
      .select('id, service, environment, started_at')
      .is('deployment_id', null)
      .not('service', 'is', null)
      // Unknown-environment incidents are never correlated — attributing a
      // staging incident to a production deploy (or vice versa) is worse
      // than not attributing it at all.
      .not('environment', 'is', null)
      .gte('started_at', lookbackStart)
      .order('started_at', { ascending: false })
      .limit(100);

    if (error || !incidents) return 0;

    let correlated = 0;

    for (const incident of incidents as Array<{
      id: string;
      service: string;
      environment: string;
      started_at: string;
    }>) {
      const incidentStart = new Date(incident.started_at).getTime();
      const windowStart = new Date(incidentStart - INCIDENT_CORRELATION_WINDOW_MS).toISOString();
      const windowEnd = incident.started_at;

      // Find the most recent deployment for this service AND environment
      // within the correlation window
      const { data: deployment } = await this.supabase
        .from('platform_deployment')
        .select('id')
        .eq('service', incident.service)
        .eq('environment', incident.environment)
        .eq('status', 'success')
        .gte('completed_at', windowStart)
        .lte('completed_at', windowEnd)
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (deployment) {
        await this.supabase
          .from('platform_incident')
          .update({ deployment_id: deployment.id, updated_at: new Date().toISOString() })
          .eq('id', incident.id);
        correlated++;
      }
    }

    return correlated;
  }

  // =========================================================================
  // Collection State Management
  // =========================================================================

  private async updateCollectionState(
    source: string,
    status: 'success' | 'error',
    errorMsg?: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      last_run_at: now,
      last_run_status: status,
      updated_at: now,
    };

    if (status === 'success') {
      update.last_collected_at = now;
      update.last_error = null;
    }
    if (status === 'error' && errorMsg) {
      update.last_error = errorMsg;
    }

    // Upsert the state record
    await this.supabase
      .from('platform_dora_collection_state')
      .upsert(
        { source, ...update, created_at: now },
        { onConflict: 'source' },
      );
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private computeSinceDate(options: CollectionOptions): Date {
    if (options.backfill && options.backfillMonths) {
      const since = new Date();
      since.setMonth(since.getMonth() - options.backfillMonths);
      return since;
    }
    // Default: last 24 hours
    const since = new Date();
    since.setHours(since.getHours() - 24);
    return since;
  }
}
