const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

export async function captureActivationEvent(
  event: string,
  userId: string,
  tenantId: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  if (!POSTHOG_KEY || POSTHOG_KEY === 'placeholder_posthog_key') return;
  try {
    await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event,
        distinct_id: userId,
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
