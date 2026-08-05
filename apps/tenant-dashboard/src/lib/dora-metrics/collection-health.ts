// ---------------------------------------------------------------------------
// DORA Metrics - Collection Health Policy
//
// Pure assessment of platform_dora_collection_state rows so the dashboard
// can surface a broken pipeline instead of silently showing "No Data Yet".
// This module exists because the original pipeline ran broken for 15 weeks
// with zero signal — every failure mode below was real.
//
// Per-source staleness policy:
// - betterstack_incidents runs on a 30-minute schedule, so anything older
//   than 4 missed ticks (2h) means the scheduled workflow stopped.
// - cd_push only updates when a deploy happens, so its threshold is in
//   days, padded past a long weekend — a quiet repo is not a broken one.
// ---------------------------------------------------------------------------

import type { CollectionStatusResponse } from './types';

type CollectionHealthLevel = 'warning' | 'error';

interface CollectionHealthIssue {
  source: string;
  level: CollectionHealthLevel;
  message: string;
}

const MS_PER_HOUR = 60 * 60 * 1000;

/** Incident collection runs every 30 min; >2h old = scheduler is down. */
const INCIDENT_STALE_AFTER_MS = 2 * MS_PER_HOUR;
/** Deploys are bursty (weekends, holidays); only flag after 5 quiet days. */
const CD_PUSH_STALE_AFTER_MS = 5 * 24 * MS_PER_HOUR;

function hoursAgo(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / MS_PER_HOUR;
}

function formatAge(iso: string, now: Date): string {
  const hours = hoursAgo(iso, now);
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Assess collection pipeline health. Returns one issue per unhealthy
 * source; an empty array means everything is flowing.
 */
export function assessCollectionHealth(
  sources: CollectionStatusResponse['sources'],
  now: Date = new Date(),
): CollectionHealthIssue[] {
  const issues: CollectionHealthIssue[] = [];
  const bySource = new Map(sources.map((s) => [s.source, s]));

  // Any source whose last run errored is broken outright. ('backfill' is a
  // one-time action and excluded — its errors surface in the backfill UI.)
  for (const source of sources) {
    if (source.source !== 'backfill' && source.last_run_status === 'error') {
      issues.push({
        source: source.source,
        level: 'error',
        message: `${source.source} collection is failing${source.last_error ? `: ${source.last_error}` : ''}`,
      });
    }
  }

  // Incident collection: never ran, or scheduler stopped ticking
  const incidents = bySource.get('betterstack_incidents');
  if (!incidents) {
    issues.push({
      source: 'betterstack_incidents',
      level: 'warning',
      message:
        'Incident collection has never run — MTTR and change failure rate will be incomplete. Check the "DORA Incident Collection" GitHub Actions workflow.',
    });
  } else if (
    incidents.last_run_status !== 'error' &&
    incidents.last_collected_at &&
    hoursAgo(incidents.last_collected_at, now) * MS_PER_HOUR > INCIDENT_STALE_AFTER_MS
  ) {
    issues.push({
      source: 'betterstack_incidents',
      level: 'warning',
      message: `Incident collection last succeeded ${formatAge(incidents.last_collected_at, now)} (expected every 30 minutes). Check the "DORA Incident Collection" GitHub Actions workflow.`,
    });
  }

  // CD push heartbeat: no deployment events lately
  const cdPush = bySource.get('cd_push');
  if (
    cdPush?.last_collected_at &&
    cdPush.last_run_status !== 'error' &&
    hoursAgo(cdPush.last_collected_at, now) * MS_PER_HOUR > CD_PUSH_STALE_AFTER_MS
  ) {
    issues.push({
      source: 'cd_push',
      level: 'warning',
      message: `No deployments recorded since ${formatAge(cdPush.last_collected_at, now)}. If you have deployed recently, the "Record deployment to DORA" CD step may be failing.`,
    });
  }

  return issues;
}
