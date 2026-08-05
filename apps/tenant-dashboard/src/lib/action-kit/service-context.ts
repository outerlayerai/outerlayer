/**
 * `ServiceContext` — the first argument every service method takes. A service
 * never constructs its own client; it receives `ctx.db` (RLS-scoped) plus the
 * resolved tenant and actor.
 *
 * ## Why the clients are interfaces here, not Supabase types
 *
 * This module commits to none of the tenancy model and imports no Supabase
 * runtime. `Db` and `Actor` are narrow interfaces the real, later-wired clients
 * will satisfy — so this foundation stands whatever the tenancy wiring decides
 * and whatever `supabase-js` version is eventually pinned, and services stay
 * unit-testable by passing a mock `db`.
 */

import { loadRequestServiceContext } from '@/lib/adapters';

/** The RLS-scoped, user-authority data client a service runs its queries through. */
interface Db {
  /** Entry point of the query builder. Widened to `unknown` — the concrete client satisfies it. */
  from(table: string): unknown;
}

/** The URL-org-derived tenant scope, validated against membership once per request. */
type TenantId = string;

/** The authenticated identity a request runs under. Services read it; never re-derive it. */
export interface Actor {
  userId: string;
  role: string;
}

/** What every service method receives first. */
export interface ServiceContext {
  db: Db;
  tenantId: TenantId;
  actor: Actor;
}

/**
 * The seam that produces a `ServiceContext` for a request. Injected into the
 * action wrapper so it can be mocked in unit tests with no Supabase or auth.
 */
export type ResolveServiceContext = () => Promise<ServiceContext>;

/**
 * The production resolver. The concrete request-bound wiring — header-scoped
 * client, URL tenant, table-driven role — lives in the adapter layer, the one
 * sanctioned crossing to the root Supabase client; this keeps action-kit itself
 * free of Supabase and framework imports.
 */
export const resolveServiceContext: ResolveServiceContext = () =>
  loadRequestServiceContext();
