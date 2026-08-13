/**
 * Explicit manifest of every migrated route.
 *
 * The spec generator (`scripts/generate-openapi.ts`) imports this file and
 * relies on side-effect imports to populate `dashboardApiRegistry`. When a
 * new route is migrated to `withApi`, add its module import here — the spec
 * won't see it otherwise.
 *
 * Why an explicit manifest rather than glob-based auto-discovery:
 *   - Import failures fail the spec build loudly instead of silently
 *     dropping the route from the spec.
 *   - The file doubles as an at-a-glance list of "which routes run under
 *     the canonical wrapper today."
 *   - Matches the gateway's approach (`apps/gateway/src/openapi/index.ts`
 *     imports every route class explicitly).
 */

import 'server-only';

// Analytics singletons still serving the spine
import '@/app/api/orgs/[orgName]/has-traces/route';

// Onboarding
import '@/app/api/orgs/[orgName]/apps/[appId]/onboarding/checklist/route';

// Agents (blobs) — the domain's one first-party binary-asset route (an <img>
// needs bytes, which a React Server Component (RSC) can't return). Session
// detail and the sessions list serve via RSC (features/agent-sessions);
// saved views are Server Actions (lib/analytics/saved-filters) — neither
// has a route here.
import '@/app/api/orgs/[orgName]/apps/[appId]/agents/blob/[sha256]/route';

// Management API — org member management (session or management-API-key bearer auth)
import '@/app/api/orgs/[orgName]/members/route';
import '@/app/api/orgs/[orgName]/members/invites/route';
import '@/app/api/orgs/[orgName]/members/invites/[inviteId]/resend/route';
import '@/app/api/orgs/[orgName]/members/[userId]/route';
import '@/app/api/orgs/[orgName]/roles/route';

// Management API — custom roles + app-level role assignment (enterprise-licensed;
// route shims validate shape, `ee/` adapters own auth + entitlement gating)
import '@/app/api/orgs/[orgName]/custom-roles/route';
import '@/app/api/orgs/[orgName]/custom-roles/[roleId]/route';
import '@/app/api/orgs/[orgName]/apps/[appId]/member-roles/route';
import '@/app/api/orgs/[orgName]/apps/[appId]/member-roles/[appMemberRoleId]/route';
