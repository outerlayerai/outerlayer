// ---------------------------------------------------------------------------
// DORA Metrics - Monitor-to-Service Mapping
//
// Maps BetterStack monitor names to platform service names. Used during
// incident collection to associate incidents with the correct service for
// DORA CFR and MTTR calculations.
// ---------------------------------------------------------------------------

/** A mapping entry: regex pattern matched against monitor names, target service. */
interface MonitorPattern {
  pattern: RegExp;
  service: string;
}

/**
 * Ordered list of patterns to match BetterStack monitor names to platform
 * services. Patterns are tested in order; first match wins — so the most
 * specific patterns MUST come before the generic ones ("API docs" has to
 * hit /docs/ before the broad /api/ catch-all claims it for gateway).
 */
export const MONITOR_SERVICE_PATTERNS: MonitorPattern[] = [
  { pattern: /docs/i, service: 'docs' },
  { pattern: /marketing/i, service: 'marketing-site' },
  { pattern: /(?:ingestion|worker)/i, service: 'ingestion-worker' },
  { pattern: /(?:dashboard|tenant)/i, service: 'tenant-dashboard' },
  { pattern: /(?:gateway|api)/i, service: 'gateway' },
];

/**
 * Host-based service mapping — the AUTHORITATIVE signal, matched first.
 *
 * The monitored URL's hostname identifies the service unambiguously, whereas
 * the monitor NAME does not: "Analytics API" watches the dashboard's
 * `app.agentmark.co/api/analytics` but the name-pattern catch-all `/api/`
 * mislabels it `gateway`, so its incidents never correlate to the dashboard
 * deploy that caused them and silently drop out of CFR/MTTR. Matching the
 * host (mirroring mapMonitorToEnvironment) fixes that and the broader landmine
 * that ANY monitor with "api" in its name was tagged gateway.
 *
 * Subdomain-anchored (`(^|\.)label\.`) so `api-stg.agentmark.co` → gateway
 * via the `api(-stg)?` arm and never trips the dashboard `stg` arm (the "stg"
 * there follows "-", not a dot/start). `app.puzzlet.ai` (legacy prod alias)
 * and `stg.agentmark.co` (staging dashboard) both resolve to tenant-dashboard.
 */
const SERVICE_HOST_PATTERNS: MonitorPattern[] = [
  { pattern: /(^|\.)docs\./i, service: 'docs' },
  { pattern: /(^|\.)api(-stg)?\./i, service: 'gateway' },
  { pattern: /(^|\.)(app|stg)\./i, service: 'tenant-dashboard' },
  { pattern: /(^|\.)(www|marketing)\./i, service: 'marketing-site' },
];

/**
 * Map a BetterStack monitor to a platform service name.
 *
 * Resolution order: the monitored URL's HOST (authoritative) first, then the
 * monitor-name patterns as a fallback for URL-less monitors (e.g. heartbeats).
 * Unmapped monitors return null and the incident is excluded from CFR/MTTR
 * correlation downstream — log so coverage gaps are visible instead of
 * silently shrinking the metrics.
 *
 * @param monitorName - The name of the BetterStack monitor
 * @param url - The monitored endpoint URL (incident attributes.url); optional
 * @returns The platform service name, or null if nothing matches
 */
export function mapMonitorToService(
  monitorName: string,
  url: string | null = null,
): string | null {
  if (url) {
    let hostname = url;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Not parseable as a URL — fall through to name patterns.
    }
    for (const { pattern, service } of SERVICE_HOST_PATTERNS) {
      if (pattern.test(hostname)) return service;
    }
  }

  if (monitorName) {
    for (const { pattern, service } of MONITOR_SERVICE_PATTERNS) {
      if (pattern.test(monitorName)) return service;
    }
  }

  console.warn(
    `[dora-collection] Monitor "${monitorName}" (url=${url ?? 'none'}) matched no service host/pattern — its incidents are excluded from CFR/MTTR`,
  );
  return null;
}

/** Hostname/name fragments that mark a staging target. Matches the real
 *  monitor URLs (api-stg.agentmark.co, stg.agentmark.co) and names
 *  ("Gateway Staging", "Dashboard STG"). */
const STAGING_SIGNAL = /(?:^|[./\s-])(?:stg|staging)(?:[./\s-]|$)/i;

/**
 * Map a BetterStack monitor to a deployment environment. BetterStack
 * monitors cover BOTH staging and production, so without this mapping a
 * staging incident would pollute production MTTR/CFR.
 *
 * The monitored URL's hostname is the primary signal (it IS the target:
 * api-stg.agentmark.co vs api.agentmark.co); the monitor name is the
 * fallback for URL-less monitors (e.g. heartbeats). A URL with no staging
 * marker is production — that's what an unmarked hostname means here. With
 * NO url and no name signal we return null (unknown) and warn: better to
 * exclude an incident from env-filtered metrics than to miscount it.
 *
 * @param monitorName - The name of the BetterStack monitor
 * @param url - The monitored endpoint URL (incident attributes.url)
 * @returns 'staging' | 'production', or null if no signal exists
 */
export function mapMonitorToEnvironment(
  monitorName: string,
  url: string | null,
): 'staging' | 'production' | null {
  if (url) {
    let hostname = url;
    try {
      hostname = new URL(url).hostname;
    } catch {
      // Not parseable as a URL — match against the raw string below.
    }
    return STAGING_SIGNAL.test(hostname) ? 'staging' : 'production';
  }

  if (monitorName) {
    if (STAGING_SIGNAL.test(monitorName)) return 'staging';
    if (/(?:^|[./\s-])prod(?:uction)?(?:[./\s-]|$)/i.test(monitorName)) return 'production';
  }

  console.warn(
    `[dora-collection] Monitor "${monitorName}" has no URL and no environment keyword — its incidents are excluded from env-filtered CFR/MTTR`,
  );
  return null;
}
