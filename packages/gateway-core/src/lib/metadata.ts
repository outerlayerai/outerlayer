/**
 * Public-API metadata shaping.
 *
 * Custom user metadata is stored in the same ClickHouse `Metadata` map as a
 * handful of internal/system keys that the platform writes itself — today the
 * `graph.node.*` namespace emitted by the OSS `observe()` wrapper.
 *
 * Returning those internal keys verbatim on the public read endpoints would
 * make them a de-facto part of the API contract (Hyrum's law) and leak
 * implementation detail. OpenTelemetry's own naming spec separates reserved
 * namespaces from user attributes for exactly this reason. So the public
 * `metadata` object excludes reserved namespaces; add prefixes here as new
 * internal namespaces are introduced.
 */

/**
 * Reserved metadata-key prefixes excluded from the public `metadata` object.
 * Keep in sync with any internal namespace written into `otel_traces.Metadata`.
 */
export const RESERVED_METADATA_PREFIXES: readonly string[] = ['graph.node.'];

/**
 * Strip reserved/internal namespaces from a metadata map for public exposure.
 * Returns a new object; the input is not mutated. `undefined`/empty in →
 * empty object out (callers spread or assign directly).
 */
export function stripReservedMetadata(
  metadata: Record<string, string> | undefined | null,
): Record<string, string> {
  if (!metadata) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (RESERVED_METADATA_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
