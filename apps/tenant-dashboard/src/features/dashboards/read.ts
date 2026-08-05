import 'server-only';

import { loadRequestServiceContext } from '@/lib/adapters';
import { NotFoundError } from '@/lib/analytics/errors';

import { dashboardsService } from './service';
import { getTemplateList } from './templates';
import type { Dashboard, DashboardSummary, DashboardTemplate } from './types';

/**
 * The React Server Component (RSC) read behind the dashboard list: every dashboard belonging to one
 * app, resolved under the request tenant. `dashboards/page.tsx` calls this
 * server-side and seeds the list — the list never fetches. Scoped by the
 * `dashboard.read` RLS policy, so a caller without the permission or outside
 * the tenant gets an empty list.
 */
export async function loadDashboardsForApp(appId: string): Promise<DashboardSummary[]> {
  const ctx = await loadRequestServiceContext();
  return dashboardsService.list(ctx, appId);
}

/**
 * The RSC read behind a dashboard's detail view. Returns null when the
 * dashboard doesn't exist or isn't visible under RLS (unknown id and
 * foreign-tenant are the same outcome, by design — no oracle) so the page
 * can render its own not-found UI instead of throwing.
 *
 * Every other failure propagates. Null is a factual claim the page renders as
 * "this dashboard is gone", so only an actual absence may produce it — a
 * blanket catch here would report a timed-out widget query as a deletion.
 */
export async function loadDashboardForApp(appId: string, dashboardId: string): Promise<Dashboard | null> {
  const ctx = await loadRequestServiceContext();
  try {
    return await dashboardsService.get(ctx, appId, dashboardId);
  } catch (err) {
    if (err instanceof NotFoundError) return null;
    throw err;
  }
}

/**
 * Resolves the app's default dashboard, creating one from the starter
 * template if none exists yet. No server component calls this today — the list
 * page has its own explicit dashboards, and no route redirects to "the"
 * default. It stays for the default-dashboard capability (a first-load
 * redirect or similar), which is decided outside this slice.
 */
export async function loadDefaultDashboardForApp(appId: string): Promise<Dashboard> {
  const ctx = await loadRequestServiceContext();
  return dashboardsService.getOrCreateDefault(ctx, appId);
}

/**
 * The static template catalog for the create-from-template gallery. Baked in
 * at build time (TypeScript constants, not user data) — no tenant scoping to
 * apply, so this reads with no request context.
 */
export async function loadTemplates(): Promise<DashboardTemplate[]> {
  return getTemplateList();
}
