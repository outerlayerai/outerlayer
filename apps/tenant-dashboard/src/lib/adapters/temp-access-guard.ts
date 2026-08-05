/**
 * Adapter bridge for the read-only temporary-access marker, which the legacy
 * services tree still owns. New-world server code (feature actions) reaches
 * it only through this named adapter, so the new→legacy crossing stays
 * visible and removable as the guard migrates.
 */
export { isTempAccessReadOnlySession } from "@/lib/system/temp-access-guard";
