/**
 * Adapter bridge for the current app/environment context, which the legacy
 * apps tree still owns. New-world client code (feature hooks/components,
 * src/lib/app-shell) reaches that context only through this named adapter, so
 * the new→legacy crossing stays visible and removable as the apps-core slice
 * migrates.
 *
 * Kept out of the adapters barrel on purpose: index.ts re-exports a server-only
 * adapter, and this is a client hook — barrelling the two together would pull
 * server-only code into any client bundle that imports the barrel. Import this
 * module directly.
 */
export { useAppContext } from "@/lib/app-shell/app-context";
