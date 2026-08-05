import { POSTHOG_UI_HOST, POSTHOG_PROJECT_ID } from '@/config-global';

/**
 * Generate a PostHog persons page URL filtered by email
 */
export function getPostHogPersonUrl(email: string): string | null {
  if (!POSTHOG_UI_HOST || !POSTHOG_PROJECT_ID) return null;

  const query = {
    kind: 'DataTableNode',
    source: {
      kind: 'ActorsQuery',
      select: ['person_display_name -- Person', 'id', 'created_at'],
      properties: [{ key: 'email', value: [email], operator: 'exact', type: 'person' }],
    },
    full: true,
    propertiesViaUrl: true,
  };

  return `${POSTHOG_UI_HOST}/project/${POSTHOG_PROJECT_ID}/persons#q=${encodeURIComponent(JSON.stringify(query))}`;
}

/**
 * Generate a PostHog tenant group URL
 * Note: Group type index 0 assumes "tenant" is the first group type configured in PostHog
 */
export function getPostHogTenantGroupUrl(tenantId: string): string | null {
  if (!POSTHOG_UI_HOST || !POSTHOG_PROJECT_ID) return null;

  return `${POSTHOG_UI_HOST}/project/${POSTHOG_PROJECT_ID}/groups/0/${encodeURIComponent(tenantId)}`;
}
