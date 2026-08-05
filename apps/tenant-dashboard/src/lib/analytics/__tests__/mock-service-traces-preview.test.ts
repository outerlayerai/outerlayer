/**
 * MockAnalyticsService.getTraces — I/O preview.
 *
 * The dev-mode mock serves the trace list whenever CLICKHOUSE_HOST is unset
 * (local dev, Vercel previews), so the I/O preview has to be wired into the
 * mock too — otherwise the feature is invisible in exactly the environment
 * developers test in. These pin that the mock derives a trace-level preview
 * (root span, GENERATION fallback) and truncates it.
 */

import { MockAnalyticsService } from '../mock-service';
import type { TenantContext, VerifiedAppId } from '@repo/observability-service';

const mockCtx: TenantContext = {
  userId: 'user-mock',
  tenantId: 'tenant-mock',
  appId: 'app-mock' as VerifiedAppId,
  dataRetentionDays: -1,
};

describe('MockAnalyticsService.getTraces I/O preview', () => {
  let service: MockAnalyticsService;

  beforeEach(() => {
    service = new MockAnalyticsService();
  });

  it('surfaces a trace-level input/output preview on at least some rows', async () => {
    const { traces } = await service.getTraces(mockCtx, { limit: 1000, offset: 0 });

    expect(traces.length).toBeGreaterThan(0);

    // The mock pool has spans with real input/output, so the preview must be
    // populated for at least one trace (proves the wiring, not just the type).
    const withInput = traces.filter((t) => typeof t.inputPreview === 'string');
    const withOutput = traces.filter((t) => typeof t.outputPreview === 'string');
    expect(withInput.length).toBeGreaterThan(0);
    expect(withOutput.length).toBeGreaterThan(0);
  });

  it('truncates each preview to at most 160 characters and never emits an empty string', async () => {
    const { traces } = await service.getTraces(mockCtx, { limit: 1000, offset: 0 });

    for (const t of traces) {
      const { inputPreview, outputPreview } = t;
      if (typeof inputPreview === 'string') {
        expect(inputPreview.length).toBeGreaterThan(0);
        expect(inputPreview.length).toBeLessThanOrEqual(160);
      }
      if (typeof outputPreview === 'string') {
        expect(outputPreview.length).toBeGreaterThan(0);
        expect(outputPreview.length).toBeLessThanOrEqual(160);
      }
    }
  });
});
