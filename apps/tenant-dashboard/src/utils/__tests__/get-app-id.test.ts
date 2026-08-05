// @vitest-environment jsdom
/**
 * Unit tests for getAppIdByName — the shared, request-cached app-name → id
 * resolver used by the `[appName]` layout, the settings layout, and the
 * settings pages.
 *
 * Boundaries (per apps/tenant-dashboard/CLAUDE.md): the `app` table lookup is
 * an HTTP boundary, served by the shared MSW supabase handler
 * (seedSupabaseMswState) — never a Supabase client mock/spy.
 */

import { getAppIdByName } from '../get-app-id';
import { seedSupabaseMswState } from '../../test-helpers/msw-handlers';

describe('getAppIdByName', () => {
  it('returns null and issues no query when appName is empty/null/undefined', async () => {
    expect(await getAppIdByName(null)).toBeNull();
    expect(await getAppIdByName(undefined)).toBeNull();
    expect(await getAppIdByName('')).toBeNull();
  });

  it('resolves the id of the RLS-visible app matching the name', async () => {
    seedSupabaseMswState({
      apps: [
        { id: 'app-1', name: 'my-app', tenant_id: 'tenant-1' },
        { id: 'app-2', name: 'other-app', tenant_id: 'tenant-1' },
      ],
    });

    expect(await getAppIdByName('my-app')).toBe('app-1');
    expect(await getAppIdByName('other-app')).toBe('app-2');
  });

  it('returns null when no visible app matches the name', async () => {
    seedSupabaseMswState({
      apps: [{ id: 'app-1', name: 'my-app', tenant_id: 'tenant-1' }],
    });

    expect(await getAppIdByName('nonexistent-app')).toBeNull();
  });
});
