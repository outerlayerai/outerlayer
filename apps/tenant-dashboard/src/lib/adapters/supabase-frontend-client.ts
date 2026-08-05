/**
 * Adapter bridge for the browser Supabase client, which the root legacy module
 * still owns. Used by the Context › History realtime surface, which stays a
 * live `postgres_changes` subscription by design. Collapses when that surface
 * re-homes off postgres_changes.
 *
 * Kept out of the adapters barrel on purpose: index.ts re-exports a server-only
 * adapter, and this is a client factory — barrelling the two together would
 * pull server-only code into any client bundle that imports the barrel. Import
 * this module directly.
 */
export { createSupabaseFontendClient } from "@/supabaseFrontendClient";
