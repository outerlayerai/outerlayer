import type { Env } from '../types';

const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/capture/';

// Stryker disable all: captureActivationEvent is a fire-and-forget analytics helper;
// all behaviour (key guard, payload shape, error swallowing) is verified via MSW in
// lib/__tests__/posthog.test.ts. Stryker's perTest coverage tracking does not
// attribute fork-pool vitest coverage for this file — see stryker-mutator/stryker-js#214.
export async function captureActivationEvent(
  env: Pick<Env, 'POSTHOG_PROJECT_API_KEY'>,
  event: string,
  distinctId: string,
  tenantId: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  const apiKey = env.POSTHOG_PROJECT_API_KEY;
  if (!apiKey) return;

  try {
    await fetch(POSTHOG_CAPTURE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event,
        distinct_id: distinctId,
        properties: {
          ...properties,
          tenant_id: tenantId,
          $groups: { tenant: tenantId },
        },
      }),
    });
  } catch {
    // fire-and-forget; never surface network errors to the caller
  }
}
// Stryker restore all
