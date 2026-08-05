// ---------------------------------------------------------------------------
// DORA Metrics - Monitor-to-Service Mapping Tests
//
// Validates the BetterStack monitor name -> platform service name mapping
// used during incident collection for DORA CFR and MTTR calculations.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import {
  mapMonitorToEnvironment,
  mapMonitorToService,
  MONITOR_SERVICE_PATTERNS,
} from '../monitor-service-map';

// ---------------------------------------------------------------------------
// MONITOR_SERVICE_PATTERNS (exported constant)
// ---------------------------------------------------------------------------

describe('MONITOR_SERVICE_PATTERNS', () => {
  it('should be an array with 5 pattern entries', () => {
    expect(Array.isArray(MONITOR_SERVICE_PATTERNS)).toBe(true);
    expect(MONITOR_SERVICE_PATTERNS).toHaveLength(5);
  });

  it('should have pattern and service properties on every entry', () => {
    for (const entry of MONITOR_SERVICE_PATTERNS) {
      expect(entry).toHaveProperty('pattern');
      expect(entry).toHaveProperty('service');
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.service).toBe('string');
      expect(entry.service.length).toBeGreaterThan(0);
    }
  });

  it('should use case-insensitive regex flags on all patterns', () => {
    for (const entry of MONITOR_SERVICE_PATTERNS) {
      expect(entry.pattern.flags).toContain('i');
    }
  });
});

// ---------------------------------------------------------------------------
// mapMonitorToService
// ---------------------------------------------------------------------------

describe('mapMonitorToService', () => {
  // -------------------------------------------------------------------------
  // Exact keyword matches (one keyword per pattern)
  // -------------------------------------------------------------------------

  describe('exact keyword matches', () => {
    it('should return tenant-dashboard when monitor contains "dashboard"', () => {
      expect(mapMonitorToService('dashboard')).toBe('tenant-dashboard');
    });

    it('should return tenant-dashboard when monitor contains "tenant"', () => {
      expect(mapMonitorToService('tenant')).toBe('tenant-dashboard');
    });

    it('should return gateway when monitor contains "gateway"', () => {
      expect(mapMonitorToService('gateway')).toBe('gateway');
    });

    it('should return gateway when monitor contains "api"', () => {
      expect(mapMonitorToService('api')).toBe('gateway');
    });

    it('should return docs when monitor contains "docs"', () => {
      expect(mapMonitorToService('docs')).toBe('docs');
    });

    it('should return marketing-site when monitor contains "marketing"', () => {
      expect(mapMonitorToService('marketing')).toBe('marketing-site');
    });

    it('should return ingestion-worker when monitor contains "ingestion"', () => {
      expect(mapMonitorToService('ingestion')).toBe('ingestion-worker');
    });

    it('should return ingestion-worker when monitor contains "worker"', () => {
      expect(mapMonitorToService('worker')).toBe('ingestion-worker');
    });
  });

  // -------------------------------------------------------------------------
  // Case insensitivity
  // -------------------------------------------------------------------------

  describe('case insensitivity', () => {
    it('should match "Dashboard" with mixed case', () => {
      expect(mapMonitorToService('Dashboard')).toBe('tenant-dashboard');
    });

    it('should match "GATEWAY" in uppercase', () => {
      expect(mapMonitorToService('GATEWAY')).toBe('gateway');
    });

    it('should match "Docs" with initial capital', () => {
      expect(mapMonitorToService('Docs')).toBe('docs');
    });

    it('should match "API" in uppercase', () => {
      expect(mapMonitorToService('API')).toBe('gateway');
    });

    it('should match "MARKETING" in uppercase', () => {
      expect(mapMonitorToService('MARKETING')).toBe('marketing-site');
    });

    it('should match "INGESTION" in uppercase', () => {
      expect(mapMonitorToService('INGESTION')).toBe('ingestion-worker');
    });

    it('should match "TENANT" in uppercase', () => {
      expect(mapMonitorToService('TENANT')).toBe('tenant-dashboard');
    });

    it('should match "WoRkEr" in mixed case', () => {
      expect(mapMonitorToService('WoRkEr')).toBe('ingestion-worker');
    });
  });

  // -------------------------------------------------------------------------
  // Realistic BetterStack monitor names
  // -------------------------------------------------------------------------

  describe('realistic monitor names', () => {
    it('should map "Production Dashboard Health" to tenant-dashboard', () => {
      expect(mapMonitorToService('Production Dashboard Health')).toBe('tenant-dashboard');
    });

    it('should map "API Gateway Uptime" to gateway', () => {
      expect(mapMonitorToService('API Gateway Uptime')).toBe('gateway');
    });

    it('should map "Docs Site SSL" to docs', () => {
      expect(mapMonitorToService('Docs Site SSL')).toBe('docs');
    });

    it('should map "Marketing Site Uptime Check" to marketing-site', () => {
      expect(mapMonitorToService('Marketing Site Uptime Check')).toBe('marketing-site');
    });

    it('should map "Ingestion Worker Health" to ingestion-worker', () => {
      expect(mapMonitorToService('Ingestion Worker Health')).toBe('ingestion-worker');
    });

    it('should map "Tenant Portal Response Time" to tenant-dashboard', () => {
      expect(mapMonitorToService('Tenant Portal Response Time')).toBe('tenant-dashboard');
    });

    it('should map "REST API Latency Monitor" to gateway', () => {
      expect(mapMonitorToService('REST API Latency Monitor')).toBe('gateway');
    });

    it('should map "Background Worker Queue Depth" to ingestion-worker', () => {
      expect(mapMonitorToService('Background Worker Queue Depth')).toBe('ingestion-worker');
    });

    it('should map "Data Ingestion Pipeline" to ingestion-worker', () => {
      expect(mapMonitorToService('Data Ingestion Pipeline')).toBe('ingestion-worker');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown monitors (no matching pattern)
  // -------------------------------------------------------------------------

  describe('unknown monitors', () => {
    it('should return null for "database"', () => {
      expect(mapMonitorToService('database')).toBeNull();
    });

    it('should return null for "redis"', () => {
      expect(mapMonitorToService('redis')).toBeNull();
    });

    it('should return null for "unknown-service"', () => {
      expect(mapMonitorToService('unknown-service')).toBeNull();
    });

    it('should return null for "clickhouse"', () => {
      expect(mapMonitorToService('clickhouse')).toBeNull();
    });

    it('should return null for "nginx"', () => {
      expect(mapMonitorToService('nginx')).toBeNull();
    });

    it('should return null for "cdn-health-check"', () => {
      expect(mapMonitorToService('cdn-health-check')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Empty / falsy input
  // -------------------------------------------------------------------------

  describe('empty and falsy input', () => {
    it('should return null for empty string', () => {
      expect(mapMonitorToService('')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // First-match priority (patterns tested in order)
  // -------------------------------------------------------------------------

  describe('first-match priority', () => {
    it('should return tenant-dashboard for "API Dashboard" because dashboard pattern is first', () => {
      // "API Dashboard" matches both pattern 1 (dashboard -> tenant-dashboard)
      // and pattern 2 (api -> gateway). First match wins.
      expect(mapMonitorToService('API Dashboard')).toBe('tenant-dashboard');
    });

    it('should return tenant-dashboard for "Tenant API Service" because tenant pattern is first', () => {
      // "Tenant API Service" matches pattern 1 (tenant) before pattern 2 (api)
      expect(mapMonitorToService('Tenant API Service')).toBe('tenant-dashboard');
    });

    it('should return ingestion-worker for "API Worker Proxy" because specific patterns precede the broad api catch-all', () => {
      // Specific patterns (worker -> ingestion-worker) are ordered before the
      // generic /(?:gateway|api)/ catch-all so names like "API docs" or
      // "API Worker Proxy" aren't all claimed by gateway.
      expect(mapMonitorToService('API Worker Proxy')).toBe('ingestion-worker');
    });

    it('should return docs for "API docs" because docs precedes the api catch-all', () => {
      expect(mapMonitorToService('API docs')).toBe('docs');
    });

    it('should return docs for "Docs Worker" because docs pattern precedes worker', () => {
      // "Docs Worker" matches pattern 3 (docs) before pattern 5 (worker)
      expect(mapMonitorToService('Docs Worker')).toBe('docs');
    });

    it('should return marketing-site for "Marketing Worker" because marketing precedes worker', () => {
      // "Marketing Worker" matches pattern 4 (marketing) before pattern 5 (worker)
      expect(mapMonitorToService('Marketing Worker')).toBe('marketing-site');
    });
  });

  // -------------------------------------------------------------------------
  // Substring matching (keyword embedded in larger words)
  // -------------------------------------------------------------------------

  describe('substring matching', () => {
    it('should match "api" within "rapid-deploy-monitor"', () => {
      // "rapid" contains "api" as a substring
      expect(mapMonitorToService('rapid-deploy-monitor')).toBe('gateway');
    });

    it('should match "docs" within "orthodocs-checker"', () => {
      expect(mapMonitorToService('orthodocs-checker')).toBe('docs');
    });

    it('should match "tenant" within "multi-tenant-probe"', () => {
      expect(mapMonitorToService('multi-tenant-probe')).toBe('tenant-dashboard');
    });
  });

  // -------------------------------------------------------------------------
  // URL host is authoritative and matched BEFORE the name patterns.
  // Regression for the bug that classified "Analytics API" as gateway (via the
  // greedy /api/ name pattern) though it monitors the dashboard, leaving its
  // incidents uncorrelated and absent from CFR/MTTR.
  // -------------------------------------------------------------------------
  describe('URL host (authoritative, beats the name)', () => {
    it('maps the dashboard analytics endpoint to tenant-dashboard despite an "API" name', () => {
      // The exact prod case: name says "API" → would be gateway by name alone.
      expect(
        mapMonitorToService('Analytics API', 'https://app.example.com/api/analytics'),
      ).toBe('tenant-dashboard');
    });

    it('maps the staging dashboard host to tenant-dashboard', () => {
      expect(
        mapMonitorToService('Analytics API', 'https://stg.example.com/api/analytics'),
      ).toBe('tenant-dashboard');
    });

    it('maps the legacy prod dashboard alias (app.puzzlet.ai) to tenant-dashboard', () => {
      expect(mapMonitorToService('Dashboard', 'https://app.puzzlet.ai/')).toBe(
        'tenant-dashboard',
      );
    });

    it('maps the gateway host to gateway', () => {
      expect(mapMonitorToService('Gateway', 'https://api.example.com/health')).toBe(
        'gateway',
      );
    });

    it('maps the staging gateway host (api-stg) to gateway, not tenant-dashboard', () => {
      // api-stg contains "stg" but after a hyphen, so it must NOT trip the
      // dashboard `stg` arm — the api arm wins.
      expect(
        mapMonitorToService('Gateway STG', 'https://api-stg.example.com/health'),
      ).toBe('gateway');
    });

    it('maps docs and marketing hosts', () => {
      expect(mapMonitorToService('x', 'https://docs.example.com/')).toBe('docs');
      expect(mapMonitorToService('x', 'https://www.example.com/')).toBe(
        'marketing-site',
      );
    });

    it('falls back to the name patterns when the URL host is unrecognized', () => {
      expect(
        mapMonitorToService('Gateway probe', 'https://example.com/ping'),
      ).toBe('gateway');
    });

    it('falls back to the name patterns when no URL is given (heartbeats)', () => {
      expect(mapMonitorToService('Dashboard heartbeat', null)).toBe(
        'tenant-dashboard',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// describe('mapMonitorToEnvironment')
//
// BetterStack monitors cover BOTH staging and production. The URL hostname is
// the primary signal; the monitor name is the fallback; no signal at all maps
// to null so the incident is excluded from env-filtered metrics rather than
// miscounted.
// ---------------------------------------------------------------------------

describe('mapMonitorToEnvironment', () => {
  describe('URL-based (primary signal)', () => {
    it('maps stg subdomains to staging', () => {
      expect(mapMonitorToEnvironment('Gateway', 'https://api-stg.example.com/health')).toBe('staging');
      expect(mapMonitorToEnvironment('Dashboard', 'https://stg.example.com/api/health')).toBe('staging');
      expect(mapMonitorToEnvironment('Docs', 'https://staging.example.com/')).toBe('staging');
    });

    it('maps unmarked hostnames to production', () => {
      expect(mapMonitorToEnvironment('Gateway', 'https://api.example.com/health')).toBe('production');
      expect(mapMonitorToEnvironment('Dashboard', 'https://app.example.com/api/health')).toBe('production');
    });

    it('does not treat stg embedded inside a word as a staging marker', () => {
      // "instigate" contains "stg" but not at a hostname-label boundary
      expect(mapMonitorToEnvironment('Monitor', 'https://instigate.example.com/')).toBe('production');
    });

    it('URL beats a contradictory monitor name', () => {
      expect(mapMonitorToEnvironment('Gateway Staging', 'https://api.example.com/health')).toBe('production');
    });
  });

  describe('name fallback (no URL)', () => {
    it('maps staging keywords in the name', () => {
      expect(mapMonitorToEnvironment('Gateway Staging', null)).toBe('staging');
      expect(mapMonitorToEnvironment('Dashboard STG', null)).toBe('staging');
    });

    it('maps production keywords in the name', () => {
      expect(mapMonitorToEnvironment('Gateway Production', null)).toBe('production');
      expect(mapMonitorToEnvironment('Gateway Prod', null)).toBe('production');
    });

    it('returns null and warns when there is no signal at all', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(mapMonitorToEnvironment('Gateway Heartbeat', null)).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('no URL and no environment keyword'),
      );
      warnSpy.mockRestore();
    });
  });
});
