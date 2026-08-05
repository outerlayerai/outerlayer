/**
 * Adapter bridge for the signed-in user's session/permissions context, which
 * the legacy auth tree still owns. New-world client code reaches that hook
 * only through this named adapter, so the new→legacy crossing stays visible
 * and removable as auth migrates.
 *
 * Kept out of the adapters barrel on purpose: index.ts re-exports a server-only
 * adapter, and this is a client hook — barrelling the two together would pull
 * server-only code into any client bundle that imports the barrel. Import this
 * module directly.
 */
export { useAuthContext } from "@/auth/hooks";
