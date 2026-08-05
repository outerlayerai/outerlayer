/**
 * Adapter bridge for the git-provider type, which `lib/system/git` owns. A
 * type-only re-export carries no runtime code across the boundary; kept as a
 * named adapter (rather than an inline `@/lib/system/git/*` import in client
 * or feature code) so the crossing stays visible, and so a `"use client"`
 * module can reach it at all — `lib/system/**` is server-tier and banned
 * there by `local/no-server-imports-in-client`.
 *
 * Kept out of the adapters barrel on purpose: index.ts re-exports a server-only
 * adapter, and this file's sibling adapters here are client-importable — keep
 * every direct-import adapter out of the barrel so no client bundle pulls the
 * server-only one in transitively. Import this module directly.
 */
export type { GitProviderType } from "@/lib/system/git/types";
