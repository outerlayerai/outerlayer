import { getPostHogPersonUrl, getPostHogTenantGroupUrl } from './posthog-urls';

// Mock the config-global module
vi.mock('@/config-global', () => ({
  POSTHOG_UI_HOST: 'https://us.posthog.com',
  POSTHOG_PROJECT_ID: '12345',
}));

describe('posthog-urls', () => {
  describe('getPostHogPersonUrl', () => {
    it('should generate a valid PostHog person URL with encoded query', () => {
      const url = getPostHogPersonUrl('user@example.com');

      expect(url).not.toBeNull();
      expect(url).toContain('https://us.posthog.com/project/12345/persons');
      expect(url).toContain('#q=');

      // Decode and verify the query structure
      const hashPart = url!.split('#q=')[1]!;
      const decodedQuery = JSON.parse(decodeURIComponent(hashPart));

      expect(decodedQuery).toEqual({
        kind: 'DataTableNode',
        source: {
          kind: 'ActorsQuery',
          select: ['person_display_name -- Person', 'id', 'created_at'],
          properties: [{ key: 'email', value: ['user@example.com'], operator: 'exact', type: 'person' }],
        },
        full: true,
        propertiesViaUrl: true,
      });
    });

    it('should handle special characters in email', () => {
      const url = getPostHogPersonUrl('user+test@example.com');

      expect(url).not.toBeNull();

      const hashPart = url!.split('#q=')[1]!;
      const decodedQuery = JSON.parse(decodeURIComponent(hashPart));

      expect(decodedQuery.source.properties[0].value).toEqual(['user+test@example.com']);
    });
  });

  describe('getPostHogTenantGroupUrl', () => {
    it('should generate a valid PostHog tenant group URL', () => {
      const url = getPostHogTenantGroupUrl('tenant-123');

      expect(url).toBe('https://us.posthog.com/project/12345/groups/0/tenant-123');
    });

    it('should encode special characters in tenant ID', () => {
      const url = getPostHogTenantGroupUrl('tenant/with spaces&special');

      expect(url).toBe(
        'https://us.posthog.com/project/12345/groups/0/tenant%2Fwith%20spaces%26special'
      );
    });

    it('should handle UUID tenant IDs', () => {
      const url = getPostHogTenantGroupUrl('550e8400-e29b-41d4-a716-446655440000');

      expect(url).toBe(
        'https://us.posthog.com/project/12345/groups/0/550e8400-e29b-41d4-a716-446655440000'
      );
    });
  });
});

describe('posthog-urls with missing config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should return null when POSTHOG_UI_HOST is missing', async () => {
    vi.doMock('@/config-global', () => ({
      POSTHOG_UI_HOST: undefined,
      POSTHOG_PROJECT_ID: '12345',
    }));

    const { getPostHogPersonUrl: getPersonUrl, getPostHogTenantGroupUrl: getTenantUrl } =
      await import('./posthog-urls');

    expect(getPersonUrl('user@example.com')).toBeNull();
    expect(getTenantUrl('tenant-123')).toBeNull();
  });

  it('should return null when POSTHOG_PROJECT_ID is missing', async () => {
    vi.doMock('@/config-global', () => ({
      POSTHOG_UI_HOST: 'https://us.posthog.com',
      POSTHOG_PROJECT_ID: undefined,
    }));

    const { getPostHogPersonUrl: getPersonUrl, getPostHogTenantGroupUrl: getTenantUrl } =
      await import('./posthog-urls');

    expect(getPersonUrl('user@example.com')).toBeNull();
    expect(getTenantUrl('tenant-123')).toBeNull();
  });

  it('should return null when both config values are missing', async () => {
    vi.doMock('@/config-global', () => ({
      POSTHOG_UI_HOST: undefined,
      POSTHOG_PROJECT_ID: undefined,
    }));

    const { getPostHogPersonUrl: getPersonUrl, getPostHogTenantGroupUrl: getTenantUrl } =
      await import('./posthog-urls');

    expect(getPersonUrl('user@example.com')).toBeNull();
    expect(getTenantUrl('tenant-123')).toBeNull();
  });
});
