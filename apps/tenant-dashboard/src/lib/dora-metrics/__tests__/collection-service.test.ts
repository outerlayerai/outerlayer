// ---------------------------------------------------------------------------
// DoraCollectionService - Unit Tests
//
// Tests BetterStack incident collection, incident-deployment correlation,
// and collection state management. HTTP boundaries (BetterStack API and
// Supabase REST) are handled by MSW per the app testing rules — no
// hand-rolled query-builder chains.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createClient } from '@supabase/supabase-js';

import { server } from '@/test-helpers/msw-server';
import {
  getSupabaseMswState,
  seedSupabaseMswState,
} from '@/test-helpers/msw-handlers';

import { DoraCollectionService } from '../collection-service';

const SUPABASE_URL = 'http://localhost:54321';
const BETTERSTACK_INCIDENTS_URL = 'https://uptime.betterstack.com/api/v3/incidents';
const BETTERSTACK_TOKEN = 'bs_test-token';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

let incidentCounter = 0;

function makeBetterStackIncident(overrides: {
  id?: string;
  name?: string;
  status?: string;
  started_at?: string;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
  cause?: string | null;
  url?: string | null;
} = {}) {
  incidentCounter++;
  return {
    id: overrides.id ?? `inc-${incidentCounter}`,
    type: 'incident',
    attributes: {
      name: overrides.name ?? 'Dashboard Monitor',
      url: overrides.url !== undefined ? overrides.url : 'https://app.example.com',
      cause: overrides.cause !== undefined ? overrides.cause : 'HTTP 500',
      status: overrides.status ?? 'Resolved',
      started_at: overrides.started_at ?? '2026-02-17T09:00:00Z',
      acknowledged_at:
        overrides.acknowledged_at !== undefined
          ? overrides.acknowledged_at
          : '2026-02-17T09:05:00Z',
      resolved_at:
        overrides.resolved_at !== undefined
          ? overrides.resolved_at
          : '2026-02-17T09:30:00Z',
    },
  };
}

/** Register a single-page BetterStack incidents response and capture request URLs. */
function seedBetterStackIncidents(
  incidents: ReturnType<typeof makeBetterStackIncident>[],
  capturedUrls: string[] = [],
) {
  server.use(
    http.get(BETTERSTACK_INCIDENTS_URL, ({ request }) => {
      capturedUrls.push(request.url);
      return HttpResponse.json({
        data: incidents,
        pagination: { next: null },
      });
    }),
  );
  return capturedUrls;
}

function makeService(environment: 'production' | 'staging' = 'production') {
  const supabase = createClient(SUPABASE_URL, 'test-service-role-key');
  return new DoraCollectionService(supabase, BETTERSTACK_TOKEN, environment);
}

beforeEach(() => {
  incidentCounter = 0;
});

// ---------------------------------------------------------------------------
// Incident collection
// ---------------------------------------------------------------------------

describe('collectBetterStackIncidents', () => {
  it('normalizes and persists incidents: status mapping, service mapping, resolution_ms', async () => {
    seedBetterStackIncidents([
      makeBetterStackIncident({
        id: 'inc-resolved',
        name: 'Dashboard Monitor',
        status: 'Resolved',
        started_at: '2026-02-17T09:00:00Z',
        resolved_at: '2026-02-17T09:30:00Z',
      }),
    ]);

    const result = await makeService().runCollection({ backfill: false });

    expect(result.ok).toBe(true);
    expect(result.betterstack_incidents).toEqual({ collected: 1, errors: [] });
    expect(getSupabaseMswState().platformIncidents).toEqual([
      expect.objectContaining({
        external_id: 'inc-resolved',
        source: 'betterstack',
        monitor_name: 'Dashboard Monitor',
        service: 'tenant-dashboard',
        // app.example.com has no staging marker → production
        environment: 'production',
        status: 'resolved',
        resolution_ms: 30 * 60 * 1000,
      }),
    ]);
  });

  it('a staging-pinned collector stores stg-hostname incidents; a production-pinned one skips them', async () => {
    seedBetterStackIncidents([
      makeBetterStackIncident({
        id: 'inc-stg-env',
        name: 'Gateway Monitor',
        url: 'https://api-stg.example.com/health',
      }),
    ]);

    // Production store: the staging incident is NOT kept — the pull itself
    // is environment-driven.
    const prodResult = await makeService('production').runCollection({ backfill: false });
    expect(prodResult.betterstack_incidents.collected).toBe(0);
    expect(getSupabaseMswState().platformIncidents).toEqual([]);

    // Staging store: kept, with the mapped environment persisted.
    const stgResult = await makeService('staging').runCollection({ backfill: false });
    expect(stgResult.betterstack_incidents.collected).toBe(1);
    expect(getSupabaseMswState().platformIncidents).toEqual([
      expect.objectContaining({
        external_id: 'inc-stg-env',
        service: 'gateway',
        environment: 'staging',
      }),
    ]);
  });

  it('maps statuses case-insensitively and defaults unknown statuses to started with a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedBetterStackIncidents([
      makeBetterStackIncident({ id: 'inc-upper', status: 'ACKNOWLEDGED' }),
      makeBetterStackIncident({ id: 'inc-unknown', status: 'Maintenance' }),
    ]);

    await makeService().runCollection({ backfill: false });

    const incidents = getSupabaseMswState().platformIncidents;
    expect(incidents).toEqual([
      expect.objectContaining({ external_id: 'inc-upper', status: 'acknowledged' }),
      expect.objectContaining({ external_id: 'inc-unknown', status: 'started' }),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown BetterStack incident status "Maintenance"'),
    );
    warnSpy.mockRestore();
  });

  it('follows pagination.next until exhausted', async () => {
    const page2Url = `${BETTERSTACK_INCIDENTS_URL}?page=2`;
    server.use(
      http.get(BETTERSTACK_INCIDENTS_URL, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('page') === '2') {
          return HttpResponse.json({
            data: [makeBetterStackIncident({ id: 'inc-page-2' })],
            pagination: { next: null },
          });
        }
        return HttpResponse.json({
          data: [makeBetterStackIncident({ id: 'inc-page-1' })],
          pagination: { next: page2Url },
        });
      }),
    );

    const result = await makeService().runCollection({ backfill: false });

    expect(result.betterstack_incidents.collected).toBe(2);
    expect(getSupabaseMswState().platformIncidents.map((i) => i.external_id)).toEqual([
      'inc-page-1',
      'inc-page-2',
    ]);
  });

  it('updates an existing incident on re-collection instead of duplicating (upsert by external_id)', async () => {
    seedSupabaseMswState({
      platformIncidents: [
        {
          id: 'platform-incident-1',
          external_id: 'inc-evolving',
          source: 'betterstack',
          monitor_name: 'Dashboard Monitor',
          service: 'tenant-dashboard',
          severity: null,
          cause: 'HTTP 500',
          status: 'started',
          url: null,
          started_at: '2026-02-17T09:00:00Z',
          acknowledged_at: null,
          resolved_at: null,
          resolution_ms: null,
          deployment_id: null,
        },
      ],
    });
    seedBetterStackIncidents([
      makeBetterStackIncident({
        id: 'inc-evolving',
        status: 'Resolved',
        resolved_at: '2026-02-17T10:00:00Z',
      }),
    ]);

    await makeService().runCollection({ backfill: false });

    const incidents = getSupabaseMswState().platformIncidents;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toEqual(
      expect.objectContaining({
        external_id: 'inc-evolving',
        status: 'resolved',
        resolved_at: '2026-02-17T10:00:00Z',
        resolution_ms: 60 * 60 * 1000,
      }),
    );
  });

  it('uses a 1-month-back from date for backfill and ~24h for incremental', async () => {
    const urls: string[] = [];
    seedBetterStackIncidents([], urls);
    const service = makeService();

    await service.runCollection({ backfill: true, backfillMonths: 1 });
    await service.runCollection({ backfill: false });

    const backfillFrom = new URL(urls[0]!).searchParams.get('from')!;
    const incrementalFrom = new URL(urls[1]!).searchParams.get('from')!;

    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    const dayAgo = new Date();
    dayAgo.setHours(dayAgo.getHours() - 24);

    expect(backfillFrom).toBe(monthAgo.toISOString().split('T')[0]);
    expect(incrementalFrom).toBe(dayAgo.toISOString().split('T')[0]);
  });
});

// ---------------------------------------------------------------------------
// Error semantics
// ---------------------------------------------------------------------------

describe('runCollection error handling', () => {
  it('returns ok:false with the error recorded and writes an error state row when BetterStack fails', async () => {
    server.use(
      http.get(BETTERSTACK_INCIDENTS_URL, () =>
        HttpResponse.json({ error: 'invalid token' }, { status: 401 }),
      ),
    );

    const result = await makeService().runCollection({ backfill: false });

    expect(result.ok).toBe(false);
    expect(result.betterstack_incidents.errors).toEqual([
      'BetterStack API error: 401 Unauthorized',
    ]);
    expect(getSupabaseMswState().platformDoraCollectionStates).toEqual([
      expect.objectContaining({
        source: 'betterstack_incidents',
        last_run_status: 'error',
        last_error: 'BetterStack API error: 401 Unauthorized',
      }),
    ]);
  });

  it('writes only a terminal success state row on success (no stuck running state)', async () => {
    seedBetterStackIncidents([makeBetterStackIncident()]);

    const result = await makeService().runCollection({ backfill: false });

    expect(result.ok).toBe(true);
    const states = getSupabaseMswState().platformDoraCollectionStates;
    expect(states).toEqual([
      expect.objectContaining({
        source: 'betterstack_incidents',
        last_run_status: 'success',
        last_error: null,
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Incident-deployment correlation
// ---------------------------------------------------------------------------

describe('correlateIncidents', () => {
  const DEPLOYMENT = {
    id: 'deploy-1',
    service: 'gateway',
    environment: 'production',
    status: 'success',
    commit_sha: 'abc',
    commit_message: null,
    branch: 'main',
    failure_reason: null,
    duration_ms: null,
    triggered_by: null,
    pipeline_url: null,
    external_id: 'gh-1-gateway-production',
    started_at: '2026-02-17T08:50:00Z',
    completed_at: '2026-02-17T08:55:00Z',
  };

  function recentIso(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  }

  it('links an uncorrelated incident to the most recent successful deployment within 60 minutes', async () => {
    const incidentStart = recentIso(10);
    const justBefore = recentIso(20);
    const earlier = recentIso(50);
    seedSupabaseMswState({
      platformDeployments: [
        { ...DEPLOYMENT, id: 'deploy-old', external_id: 'e1', completed_at: earlier },
        { ...DEPLOYMENT, id: 'deploy-recent', external_id: 'e2', completed_at: justBefore },
      ],
      platformIncidents: [
        {
          id: 'platform-incident-1',
          external_id: 'inc-1',
          source: 'betterstack',
          monitor_name: 'Gateway Monitor',
          service: 'gateway',
          severity: null,
          cause: null,
          environment: 'production',
          status: 'resolved',
          url: null,
          started_at: incidentStart,
          acknowledged_at: null,
          resolved_at: incidentStart,
          resolution_ms: 0,
          deployment_id: null,
        },
      ],
    });

    const correlated = await makeService().correlateIncidents();

    expect(correlated).toBe(1);
    expect(getSupabaseMswState().platformIncidents[0]).toEqual(
      expect.objectContaining({ deployment_id: 'deploy-recent' }),
    );
  });

  it('does not correlate when no successful deployment falls in the window', async () => {
    const incidentStart = recentIso(10);
    seedSupabaseMswState({
      platformDeployments: [
        // Failed deploy inside the window — must not correlate
        { ...DEPLOYMENT, id: 'deploy-failed', status: 'failure', completed_at: recentIso(30) },
        // Successful deploy way outside the window
        { ...DEPLOYMENT, id: 'deploy-ancient', external_id: 'e9', completed_at: recentIso(200) },
      ],
      platformIncidents: [
        {
          id: 'platform-incident-1',
          external_id: 'inc-1',
          source: 'betterstack',
          monitor_name: 'Gateway Monitor',
          service: 'gateway',
          severity: null,
          cause: null,
          environment: 'production',
          status: 'started',
          url: null,
          started_at: incidentStart,
          acknowledged_at: null,
          resolved_at: null,
          resolution_ms: null,
          deployment_id: null,
        },
      ],
    });

    const correlated = await makeService().correlateIncidents();

    expect(correlated).toBe(0);
    expect(getSupabaseMswState().platformIncidents[0]!.deployment_id).toBeNull();
  });

  it('retries previously uncorrelated incidents on a later run once the deployment has arrived', async () => {
    const incidentStart = recentIso(10);
    seedSupabaseMswState({
      platformIncidents: [
        {
          id: 'platform-incident-1',
          external_id: 'inc-late',
          source: 'betterstack',
          monitor_name: 'Gateway Monitor',
          service: 'gateway',
          severity: null,
          cause: null,
          environment: 'production',
          status: 'resolved',
          url: null,
          started_at: incidentStart,
          acknowledged_at: null,
          resolved_at: incidentStart,
          resolution_ms: 0,
          deployment_id: null,
        },
      ],
    });
    const service = makeService();

    // First run: deployment hasn't been pushed yet
    expect(await service.correlateIncidents()).toBe(0);

    // CD push lands the deployment afterwards
    seedSupabaseMswState({
      platformDeployments: [
        { ...DEPLOYMENT, id: 'deploy-late', completed_at: recentIso(20) },
      ],
    });

    // Next scheduled run picks it up
    expect(await service.correlateIncidents()).toBe(1);
    expect(getSupabaseMswState().platformIncidents[0]!.deployment_id).toBe('deploy-late');
  });

  it('never correlates across environments — a staging incident ignores a production deploy in the window', async () => {
    const incidentStart = recentIso(10);
    seedSupabaseMswState({
      platformDeployments: [
        // Production deploy of the same service, inside the 60-min window
        { ...DEPLOYMENT, id: 'deploy-prod', environment: 'production', completed_at: recentIso(20) },
      ],
      platformIncidents: [
        {
          id: 'platform-incident-1',
          external_id: 'inc-stg',
          source: 'betterstack',
          monitor_name: 'Gateway Staging',
          service: 'gateway',
          environment: 'staging',
          severity: null,
          cause: null,
          status: 'resolved',
          url: 'https://api-stg.example.com/health',
          started_at: incidentStart,
          acknowledged_at: null,
          resolved_at: incidentStart,
          resolution_ms: 0,
          deployment_id: null,
        },
      ],
    });

    expect(await makeService().correlateIncidents()).toBe(0);
    expect(getSupabaseMswState().platformIncidents[0]!.deployment_id).toBeNull();

    // The matching staging deploy arrives — now it correlates
    seedSupabaseMswState({
      platformDeployments: [
        { ...DEPLOYMENT, id: 'deploy-prod', environment: 'production', completed_at: recentIso(20) },
        { ...DEPLOYMENT, id: 'deploy-stg', external_id: 'e-stg', environment: 'staging', completed_at: recentIso(25) },
      ],
    });
    expect(await makeService().correlateIncidents()).toBe(1);
    expect(getSupabaseMswState().platformIncidents[0]!.deployment_id).toBe('deploy-stg');
  });

  it('never correlates incidents whose environment could not be inferred', async () => {
    const incidentStart = recentIso(10);
    seedSupabaseMswState({
      platformDeployments: [
        { ...DEPLOYMENT, id: 'deploy-1', completed_at: recentIso(20) },
      ],
      platformIncidents: [
        {
          id: 'platform-incident-1',
          external_id: 'inc-unknown-env',
          source: 'betterstack',
          monitor_name: 'Mystery Heartbeat',
          service: 'gateway',
          environment: null,
          severity: null,
          cause: null,
          status: 'resolved',
          url: null,
          started_at: incidentStart,
          acknowledged_at: null,
          resolved_at: incidentStart,
          resolution_ms: 0,
          deployment_id: null,
        },
      ],
    });

    expect(await makeService().correlateIncidents()).toBe(0);
    expect(getSupabaseMswState().platformIncidents[0]!.deployment_id).toBeNull();
  });
});
