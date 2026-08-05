// ---------------------------------------------------------------------------
// Gateway permission constants for dashboard UI
//
// The `satisfies` clause on GATEWAY_PERMISSIONS binds every `key` back to the
// `app_permission` SQL enum via the generated `Database` types. If somebody
// renames or drops a permission in the SQL enum and forgets to update this
// file, TypeScript will error at build time — preventing the class of drift
// that produced the `trace.ingest` → `trace.write` bug (Apr 2026).
// ---------------------------------------------------------------------------

import type { Database } from '../types/db';

type AppPermission = Database['public']['Enums']['app_permission'];

// eslint-disable-next-line import/no-unused-modules -- used by backfill script and future phases
export type GatewayPermission = AppPermission;

export const GATEWAY_PERMISSIONS = [
  { key: 'trace.write', label: 'Ingest traces', category: 'Traces', isDefault: true },
  { key: 'trace.read', label: 'Read traces', category: 'Traces', isDefault: true },
  { key: 'score.write', label: 'Write scores', category: 'Scores', isDefault: true },
  { key: 'score.read', label: 'Read scores', category: 'Scores', isDefault: false },
  { key: 'score.delete', label: 'Delete scores', category: 'Scores', isDefault: false },
  { key: 'span.read', label: 'Read spans', category: 'Spans', isDefault: false },
  { key: 'session.read', label: 'Read sessions', category: 'Sessions', isDefault: false },
  { key: 'metrics.read', label: 'Read metrics', category: 'Metrics', isDefault: false },
  { key: 'experiment.read', label: 'Read experiments', category: 'Experiments', isDefault: false },
  { key: 'api_key.read', label: 'Read API keys', category: 'API Keys', isDefault: false },
  { key: 'api_key.insert', label: 'Create API keys', category: 'API Keys', isDefault: false },
  { key: 'api_key.delete', label: 'Delete API keys', category: 'API Keys', isDefault: false },
  // Environment lifecycle permissions. `environment.promote`
  // gates both forward promote and rollback.
  { key: 'environment.read', label: 'Read environments', category: 'Environments', isDefault: false },
  { key: 'environment.insert', label: 'Create environments', category: 'Environments', isDefault: false },
  { key: 'environment.update', label: 'Update environments', category: 'Environments', isDefault: false },
  { key: 'environment.delete', label: 'Delete environments', category: 'Environments', isDefault: false },
  { key: 'environment.promote', label: 'Promote / roll back environments', category: 'Environments', isDefault: false },
  // Apps — only `app.read` is grantable on an API key. Every API key is
  // *app-scoped* (bound to one app via X-Outerlayer-App-Id), but app
  // create/update/delete operate at the TENANT tier: the gateway authorizes
  // them on tenant_id alone (gateway_tenant_{insert,update,delete}_app RLS in
  // 95-gateway-rls.sql + the flat permission check in
  // apps/gateway/src/lib/permissions.ts), never against the key's bound app.
  // A key minted "in app A" with app.delete could therefore delete sibling
  // app B in the same tenant — tenant-wide reach from a credential the
  // user believes is confined to one app. Provision/manage apps from the
  // dashboard or a session-bearer (`outerlayer login`) flow, which is
  // genuinely tenant-wide, instead. `app.read` stays: reading the key's own
  // app metadata is app-scoped and legitimate, and the read-only preset
  // relies on it. (Removing app.{insert,update,delete} from this list also
  // makes the server action reject them — VALID_PERMISSION_KEYS in
  // api-keys/actions.ts is derived from these keys.)
  { key: 'app.read', label: 'Read apps', category: 'Apps', isDefault: false },
  // Cloud workers — lets an integration key (Slack bot, another
  // coding agent) launch runs / continue sessions via /api/v1/workers and read
  // their status. Deliberately NOT default: launching compute is a spend lever.
  { key: 'worker_run.read', label: 'Read worker runs', category: 'Workers', isDefault: false },
  { key: 'worker_run.insert', label: 'Launch worker runs', category: 'Workers', isDefault: false },
] as const satisfies ReadonlyArray<{
  key: AppPermission;
  label: string;
  category: string;
  isDefault: boolean;
}>;

export const GATEWAY_ROLES = [
  {
    id: 'sdk',
    label: 'SDK',
    description: 'CLI and SDK integrations — ingest traces and write scores',
    permissions: ['trace.write', 'score.write'] as GatewayPermission[],
  },
  {
    id: 'read-only',
    label: 'Read-Only',
    description: 'Dashboard and BI tools — read-only access to all data',
    permissions: [
      'trace.read',
      'span.read',
      'session.read',
      'score.read',
      'metrics.read',
      // Read-only role gains environment.read.
      'environment.read',
      'app.read',
    ] as GatewayPermission[],
  },
  {
    id: 'full-access',
    label: 'Full Access',
    description: 'Admin and CI pipelines — all permissions',
    permissions: GATEWAY_PERMISSIONS.map((p) => p.key) as unknown as GatewayPermission[],
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Select individual permissions',
    permissions: [] as GatewayPermission[],
  },
] as const;

export const PERMISSION_CATEGORIES: string[] = Array.from(
  new Set(GATEWAY_PERMISSIONS.map((p) => p.category))
);

export function getPermissionsForRole(roleId: string): string[] {
  const role = GATEWAY_ROLES.find((r) => r.id === roleId);
  return role ? [...role.permissions] : [];
}
