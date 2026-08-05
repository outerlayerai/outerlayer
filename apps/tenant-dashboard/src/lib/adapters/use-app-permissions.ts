/**
 * Adapter bridge for the app-scoped permissions hook, which the legacy auth
 * tree still owns. Collapses when the RBAC hooks re-home out of auth/.
 *
 * Kept out of the adapters barrel on purpose: index.ts re-exports a server-only
 * adapter, and this is a client hook — barrelling the two together would pull
 * server-only code into any client bundle that imports the barrel. Import this
 * module directly.
 */
export { useAppPermissions } from "@/auth/hooks/use-app-permissions";
