import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../test-helpers/msw-server';

const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/capture/';

describe('captureActivationEvent', () => {
  const capturedBodies: unknown[] = [];

  beforeEach(() => {
    capturedBodies.length = 0;
    server.use(
      http.post(POSTHOG_CAPTURE_URL, async ({ request }) => {
        capturedBodies.push(await request.json());
        return HttpResponse.json({});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('returns without calling PostHog when NEXT_PUBLIC_POSTHOG_KEY is not set', async () => {
    const { captureActivationEvent } = await import('../posthog-server');
    await captureActivationEvent('org_provisioned', 'user-1', 'tenant-1');
    expect(capturedBodies).toHaveLength(0);
  });

  it('returns without calling PostHog when key is the placeholder value', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'placeholder_posthog_key');
    vi.resetModules();
    const { captureActivationEvent } = await import('../posthog-server');
    await captureActivationEvent('org_provisioned', 'user-1', 'tenant-1');
    expect(capturedBodies).toHaveLength(0);
  });

  it('sends event with correct payload including org group and tenant_id', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test123');
    vi.resetModules();
    const { captureActivationEvent } = await import('../posthog-server');
    await captureActivationEvent('org_provisioned', 'user-1', 'tenant-1', {
      organization_name: 'Acme',
    });
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toEqual({
      api_key: 'phc_test123',
      event: 'org_provisioned',
      distinct_id: 'user-1',
      properties: {
        organization_name: 'Acme',
        tenant_id: 'tenant-1',
        $groups: { tenant: 'tenant-1' },
      },
    });
  });

  it('swallows fetch errors and resolves without throwing', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test123');
    vi.resetModules();
    server.use(http.post(POSTHOG_CAPTURE_URL, () => HttpResponse.error()));
    const { captureActivationEvent } = await import('../posthog-server');
    await expect(
      captureActivationEvent('org_provisioned', 'user-1', 'tenant-1'),
    ).resolves.toBeUndefined();
  });
});
