/**
 * @repo/adapter-config
 *
 * The shared deploy-time toggle layer for the OSS-migration adapter seams. Each
 * vendor seam (error reporting, email, and the infra seams to come — Unkey,
 * blob storage, queues, billing) reuses these primitives to decide, at boot,
 * whether it is enabled and which backend to wire (hosted vendor / self-host /
 * no-op):
 *
 *  - {@link parseEnvBoolean} / {@link firstNonEmpty} / {@link resolveNeutralValue}
 *    — env-string parsing + vendor-neutral-name-with-legacy-fallback resolution;
 *  - {@link resolveToggle} — the universal enabled/backend decision, with the
 *    clamp invariant that keeps a seam's boot path and adapter factory in sync;
 *  - {@link warnLegacyOnce} — a one-time, per-seam deprecation warning.
 *
 * Everything here is pure and runtime-agnostic — no SDK imports, no Node
 * built-ins, no `process` access — so it bundles into both the Cloudflare
 * Workers gateway and the Next.js dashboard. Each seam's connection config and
 * its app-side facade (which reads the actual env) live with the seam.
 */

export {
  parseEnvBoolean,
  firstNonEmpty,
  resolveNeutralValue,
} from './primitives';
export type { NeutralValueResolution } from './primitives';

export { resolveToggle } from './toggle';
export type { ToggleSpec, ToggleResult } from './toggle';

export { warnLegacyOnce, resetWarnLatch } from './warn';
