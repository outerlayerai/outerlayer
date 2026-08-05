import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../test-helpers/msw-server';
import type { Env } from '../../types';
import { captureActivationEvent } from '../posthog';

const envWithKey = { POSTHOG_PROJECT_API_KEY: 'phc_test123' } as unknown as Env;
const envNoKey = {} as unknown as Env;

const capturedBodies: unknown[] = [];

beforeEach(() => {
  capturedBodies.length = 0;
  server.use(
    http.post('https://us.i.posthog.com/capture/', async ({ request }) => {
      capturedBodies.push(await request.json());
      return HttpResponse.json({});
    }),
  );
});

describe('captureActivationEvent', () => {
  it('returns without calling PostHog when POSTHOG_PROJECT_API_KEY is not set', async () => {
    await captureActivationEvent(envNoKey, 'org_provisioned', 'user-1', 'tenant-1');
    expect(capturedBodies).toHaveLength(0);
  });

  it('posts to the PostHog capture endpoint with correct payload', async () => {
    await captureActivationEvent(envWithKey, 'org_provisioned', 'user-1', 'tenant-1');
    expect(capturedBodies).toHaveLength(1);
    expect(capturedBodies[0]).toEqual({
      api_key: 'phc_test123',
      event: 'org_provisioned',
      distinct_id: 'user-1',
      properties: {
        tenant_id: 'tenant-1',
        $groups: { tenant: 'tenant-1' },
      },
    });
  });

  it('merges extra properties into the PostHog payload', async () => {
    await captureActivationEvent(envWithKey, 'org_api_key_created', 'tenant:t1', 't1', {
      app_id: 'app-x',
    });
    expect(capturedBodies[0]).toEqual({
      api_key: 'phc_test123',
      event: 'org_api_key_created',
      distinct_id: 'tenant:t1',
      properties: {
        app_id: 'app-x',
        tenant_id: 't1',
        $groups: { tenant: 't1' },
      },
    });
  });

  it('swallows network errors and resolves without throwing', async () => {
    server.use(
      http.post('https://us.i.posthog.com/capture/', () => HttpResponse.error()),
    );
    await expect(
      captureActivationEvent(envWithKey, 'org_first_trace', 'tenant:t2', 't2'),
    ).resolves.toBeUndefined();
  });
});
