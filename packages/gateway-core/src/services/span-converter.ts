import { modelsCostMapping, resolveModelPrice } from "@repo/llm-costs";
import type { NormalizedSpan } from "@repo/shared-utils";
import type { UserMeta, PricingData } from "../types";
import { containsMedia } from "../utils/media-detection";

/**
 * Raw OTLP attribute keys the normalizer also extracts into the first-class
 * Input/Output columns. The same payload therefore lands in the row TWICE: the
 * normalized column (which blob-offload lifts to R2 when large) and this raw
 * copy in SpanAttributes (which offload never touches). For a big generation
 * the raw copy duplicates the whole payload inline — doubling storage and, at
 * the queue boundary, pushing the message past Cloudflare's 128KB limit so the
 * span gets dropped. We drop the raw copy when it is large enough to be
 * offloaded, OR when it is media (which is always offloaded — see
 * `stripRedundantIoAttributes`); the full value is preserved in the offloaded
 * Input/Output column. Small non-media values are left in place, so normal
 * traces are unchanged and still show the attribute in the drawer.
 */
const EXTRACTED_IO_ATTRIBUTE_KEYS = [
  "gen_ai.request.input",
  "gen_ai.response.output",
  "gen_ai.prompt",
  "gen_ai.completion",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "agentmark.input",
  "agentmark.output",
  "llm.input_messages",
  "llm.output_messages",
  "traceloop.entity.input",
  "traceloop.entity.output",
  "input.value",
  "output.value",
] as const;

/**
 * Byte size over which a redundant raw I/O attribute is dropped — matches the
 * blob-offload threshold, so the rule is exactly "if the normalized column gets
 * offloaded to R2, drop the duplicate raw copy."
 */
const REDUNDANT_IO_ATTR_BYTES = 32 * 1024;

const ioAttrEncoder = new TextEncoder();

/**
 * Remove the redundant raw I/O attributes (see EXTRACTED_IO_ATTRIBUTE_KEYS) from
 * a span-attributes bag IN PLACE. Drops an attribute when it is large enough to
 * be offloaded OR when it is media (media is always offloaded, so its base64
 * must not linger inline here). Returns the number dropped. Pure + exported for
 * direct testing.
 */
export function stripRedundantIoAttributes(spanAttributes: Record<string, unknown>): number {
  let dropped = 0;
  for (const key of EXTRACTED_IO_ATTRIBUTE_KEYS) {
    const value = spanAttributes[key];
    if (value === undefined) continue;
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const bytes = ioAttrEncoder.encode(serialized).length;
    if (bytes > REDUNDANT_IO_ATTR_BYTES || containsMedia(serialized)) {
      delete spanAttributes[key];
      dropped++;
    }
  }
  return dropped;
}

/**
 * Extract and validate tags from span/resource attributes.
 * Looks for `agentmark.tags` — accepts JSON array string, comma-separated string, or native array.
 */
function extractTags(attributes: Record<string, unknown>): string[] {
  const raw = attributes['agentmark.tags'];
  if (!raw) return [];

  let tags: string[];
  if (Array.isArray(raw)) {
    tags = raw.map(String);
  } else if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      tags = Array.isArray(parsed) ? parsed.map(String) : [raw];
    } catch {
      tags = raw.split(',').map((t: string) => t.trim());
    }
  } else {
    return [];
  }

  return tags
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length <= 100)
    .slice(0, 20);
}

/**
 * Canonical StatusCode normalization (single write-side source of truth).
 *
 * OTLP encodes `status.code` differently depending on the SDK/JSON encoder:
 * protobuf-JSON may emit the numeric enum value (0/1/2) OR the enum name
 * ('STATUS_CODE_ERROR'), and some exporters emit short names ('Error', 'OK').
 * The normalizer stringifies whatever it received, so without this mapping
 * the stored `otel_traces.StatusCode` column ends up with a mixed vocabulary
 * and every consumer has to guess (countIf(StatusCode != '2') silently counts
 * 'STATUS_CODE_ERROR' rows as successes).
 *
 * Canonical storage form: the OTLP numeric strings '0' (Unset) / '1' (Ok) /
 * '2' (Error). Chosen because the overwhelming majority of EXISTING rows are
 * already numeric (the normalizer's `code.toString()` path), so canonicalizing
 * to numeric requires no data migration — read queries keep accepting the
 * legacy string variants for old rows during the transition (see
 * STATUS_NORMALIZED_SQL / STATUS_ERROR_VALUES_SQL in
 * packages/observability-service/src/queries.ts).
 *
 * Unknown values pass through unchanged (visible > silently coerced); the
 * read-side normalizer surfaces them as 'UNKNOWN'.
 */
const OTLP_STATUS_CODE_MAP: Record<string, string> = {
  // Unset
  "0": "0",
  STATUS_CODE_UNSET: "0",
  UNSET: "0",
  Unset: "0",
  // Ok
  "1": "1",
  STATUS_CODE_OK: "1",
  OK: "1",
  Ok: "1",
  // Error
  "2": "2",
  STATUS_CODE_ERROR: "2",
  ERROR: "2",
  Error: "2",
};

export function normalizeOtlpStatusCode(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw === "") {
    return "0";
  }
  return OTLP_STATUS_CODE_MAP[raw] ?? raw;
}

/**
 * Stored-value equivalence sets per canonical numeric code. New rows are
 * canonical ('0'/'1'/'2'); legacy rows may hold OTLP enum-name variants, so
 * status FILTERS must match the whole set until legacy rows age out (90-day
 * TTL). Keep in sync with STATUS_ERROR_VALUES_SQL in
 * packages/observability-service/src/queries.ts.
 */
const STATUS_CODE_EQUIVALENTS: Record<string, string[]> = {
  "0": ["0", "STATUS_CODE_UNSET", "UNSET", "Unset"],
  "1": ["1", "STATUS_CODE_OK", "OK", "Ok"],
  "2": ["2", "STATUS_CODE_ERROR", "ERROR", "Error"],
};

/**
 * Expands a status code (canonical numeric OR any OTLP name variant — the
 * input is normalized first) to every stored value that means the same
 * thing, for use with `StatusCode IN {param:Array(String)}` filters.
 * Unknown codes filter on themselves only.
 */
export function statusCodeEquivalents(code: string): string[] {
  const canonical = normalizeOtlpStatusCode(code);
  return STATUS_CODE_EQUIVALENTS[canonical] ?? [canonical];
}

const getCostFormula = (
  inputCost: number,
  outputCost: number,
  unitScale: number
) => {
  return (inputTokens: number, outputTokens: number) => {
    const cost = inputCost * inputTokens + outputCost * outputTokens;
    return cost / unitScale;
  };
};

/**
 * Convert attributes object to ClickHouse Map format (all values as strings)
 */
function attributesToClickHouseMap(attrs: Record<string, any>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs || {})) {
    // Convert all values to strings for ClickHouse Map(LowCardinality(String), String)
    if (value === null || value === undefined) {
      map[key] = "";
    } else if (typeof value === "object") {
      map[key] = JSON.stringify(value);
    } else {
      map[key] = String(value);
    }
  }
  return map;
}

/**
 * Convert NormalizedSpan to ClickHouse row format
 * @param span - The normalized span to convert
 * @param meta - User metadata including custom cost mapping
 * @param pricingData - Optional pricing data from cache/GitHub (falls back to bundled data)
 */
export function normalizedSpanToClickHouseRow(
  span: NormalizedSpan,
  meta: UserMeta,
  pricingData?: PricingData
) {
  // Use provided pricing data or fall back to bundled data
  const pricing: PricingData = pricingData || (modelsCostMapping as PricingData);
  // Convert startTime from milliseconds to nanoseconds (DateTime64(9) expects nanoseconds)
  const timestampNs = Math.floor(span.startTime * 1000000);

  // Convert endTime from milliseconds to nanoseconds if available
  const endTimeNs = span.endTime ? Math.floor(span.endTime * 1000000) : 0;

  // Duration is stored in milliseconds (no conversion needed)
  const durationMs = Math.floor(span.duration);

  // Normalize StatusCode to the canonical OTLP numeric strings ('0'/'1'/'2')
  // before it influences cost logic or is written to ClickHouse.
  const statusCode = normalizeOtlpStatusCode(span.statusCode);

  // Calculate cost
  let cost = span.cost || 0;
  const isSuccess = statusCode !== "2";
  const spanAttributes = { ...span.spanAttributes };
  // Drop large raw I/O attributes already captured (and offloaded) by the
  // normalized Input/Output columns — they would otherwise duplicate the whole
  // payload inline and blow the queue message limit.
  stripRedundantIoAttributes(spanAttributes);


  if (span.model && span.inputTokens !== undefined && span.outputTokens !== undefined) {
    // Registry pricing only. The shared layered resolver (exact → normalized id
    // → prefix fallback) prices provider-prefixed, fine-tuned, or dated model
    // ids; a model absent from the registry falls back to cost 0.
    const priceMap = isSuccess ? resolveModelPrice(span.model, pricing) : null;
    const getCost = getCostFormula(
      Number(priceMap?.promptPrice || 0),
      Number(priceMap?.completionPrice || 0),
      1000
    );
    cost = getCost(span.inputTokens || 0, span.outputTokens || 0);
  }

  // Convert events to ClickHouse array format (arrays are more efficient in ClickHouse)
  const eventsTimestamp = span.events.map((e: { timestamp: number }) => Math.floor(e.timestamp * 1000000));
  const eventsName = span.events.map((e: { name: string }) => e.name);
  const eventsAttributes = span.events.map((e: { attributes?: Record<string, any> }) => attributesToClickHouseMap(e.attributes || {}));

  // Convert links to ClickHouse array format (arrays are more efficient in ClickHouse)
  const linksTraceId = span.links.map((l: { traceId: string }) => l.traceId);
  const linksSpanId = span.links.map((l: { spanId: string }) => l.spanId);
  const linksTraceState = span.links.map((l: { traceState?: string }) => l.traceState || "");
  const linksAttributes = span.links.map((l: { attributes?: Record<string, any> }) => attributesToClickHouseMap(l.attributes || {}));

  // Env stamping.
  // `meta.resolvedEnv` is the environment bound to the request's API key,
  // resolved + attached by the trace ingest route. When absent (legacy
  // ingest, bearer auth, or a key with no env binding) the row gets the
  // ClickHouse defaults: Environment='' / EnvironmentVersion=0.
  const env = meta.resolvedEnv;
  // CommitSha policy (coherent triple, server-controlled trust):
  //   - env resolved (pinned OR unpinned) → env's latest-deployment commit is
  //                   AUTHORITATIVE. It's set by the deploy/sync pipeline (the
  //                   resolver pulls `latest_deployment.commit_sha`, which
  //                   updates on every sync for an unpinned env and stays
  //                   frozen at the pinned commit for a pinned env — see
  //                   environment-resolver.ts). We do NOT trust SDK-
  //                   supplied span.commitSha here: callers can claim any
  //                   commit they like, but they can't move the server's
  //                   deploy pointer. This keeps (Environment, EnvironmentVersion,
  //                   CommitSha) coherent for pinned envs AND keeps unpinned
  //                   envs stamped with the actually-deployed commit instead
  //                   of whatever the caller's SDK happened to know about.
  //   - env resolved but no deployment yet (current_version=0,
  //     latest_deployment=null) → empty string. Better an empty stamp than a
  //     phantom SDK-claimed sha on an env that has nothing deployed.
  //   - env unresolved (legacy / bearer auth / revoked key) → SDK-supplied
  //                   span.commitSha. No server pointer to reference; SDK is
  //                   the only signal available for this ingest path.
  //
  // Trust-but-verify (prompt-version linking): regular runPrompt traces now
  // ALSO carry an SDK-supplied commitSha (the sha the gateway served the
  // prompt content at, echoed back via agentmark_meta.commit_sha). On
  // env-resolved traffic the SDK sha is accepted IFF it exactly matches the
  // env's server-side deploy pointer (`pinned_commit_sha` =
  // `latest_deployment.commit_sha` — see environment-resolver.ts). Validating
  // against the env's FULL deployment history would require a per-span DB
  // query (the resolver meta only carries the latest deployment), so the
  // cheapest sound policy is exact-match-or-server-wins: a matching client
  // sha is redundant with the server pointer (accepting it changes nothing),
  // and any non-matching client sha — including one claimed against an env
  // with no deployment yet — is discarded in favor of the server value. This
  // preserves the anti-spoofing property verbatim: a caller can never move
  // an env-resolved row's CommitSha off the server's deploy pointer.
  const commitSha = env != null
    ? (span.commitSha && span.commitSha === env.pinned_commit_sha
        ? span.commitSha
        : env.pinned_commit_sha ?? "")
    : span.commitSha || "";

  return {
    Timestamp: timestampNs,
    // Set CreatedAt explicitly so billing queries (toYYYYMM(CreatedAt) = toYYYYMM(now())) work
    // correctly. ClickHouse DEFAULT now() is not evaluated for omitted fields with async inserts.
    // DateTime stores Unix seconds, so divide Date.now() (ms) by 1000.
    CreatedAt: Math.floor(Date.now() / 1000),
    TraceId: span.traceId,
    SpanId: span.spanId,
    ParentSpanId: span.parentSpanId || "",
    TraceState: span.traceState || "",
    SpanName: span.name,
    SpanKind: span.semanticKind || 'function',
    ServiceName: span.serviceName || "",
    ResourceAttributes: attributesToClickHouseMap(span.resourceAttributes || {}),
    SpanAttributes: attributesToClickHouseMap(spanAttributes),
    Duration: durationMs,
    EndTime: endTimeNs,
    StatusCode: statusCode,
    StatusMessage: span.statusMessage || "",
    "Events.Timestamp": eventsTimestamp,
    "Events.Name": eventsName,
    "Events.Attributes": eventsAttributes,
    "Links.TraceId": linksTraceId,
    "Links.SpanId": linksSpanId,
    "Links.TraceState": linksTraceState,
    "Links.Attributes": linksAttributes,
    // Normalized columns
    Type: span.type,
    Model: span.model || "",
    InputTokens: span.inputTokens || 0,
    OutputTokens: span.outputTokens || 0,
    TotalTokens: span.totalTokens || 0,
    ReasoningTokens: span.reasoningTokens || 0,
    Cost: cost,
    Input: span.input ? JSON.stringify(span.input) : "",
    Output: span.output || "",
    OutputObject: span.outputObject ? JSON.stringify(span.outputObject) : "",
    ToolCalls: span.toolCalls ? JSON.stringify(span.toolCalls) : "",
    // Pointer to oversized field payloads lifted to object storage; populated
    // by the blob-offload pass AFTER row construction (see utils/blob-offload.ts).
    // Empty string = nothing offloaded (the common case).
    BlobRefs: "",
    FinishReason: span.finishReason || "",
    Settings: span.settings ? JSON.stringify(span.settings) : "",
    SessionId: span.sessionId || "",
    SessionName: span.sessionName || "",
    UserId: span.userId || "",
    TraceName: span.traceName || "",
    Props: span.props || "",
    Metadata: attributesToClickHouseMap(span.metadata || {}),
    CommitSha: commitSha,
    // SourceTreeHash is the run's git tree hash and is PURE PASSTHROUGH —
    // unlike CommitSha, which pinned envs override with the deployed commit
    // above.
    SourceTreeHash: span.sourceTreeHash || "",
    // Tags (extracted from span/resource attributes)
    Tags: extractTags({ ...span.resourceAttributes, ...span.spanAttributes }),
    // Env tagging.
    Environment: env?.name ?? "",
    EnvironmentVersion: env?.pinned_version ?? 0,
    // Gateway-resolved API-key traffic is always 'production'. Any
    // client-supplied trace_source is stripped at the ingest route; the
    // converter unconditionally stamps 'production'.
    TraceSource: "production",
    // Tenant/app metadata (regular columns, not materialized)
    AppId: meta.appId,
    TenantId: meta.tenantId,
    StripeCustomerId: meta.stripeCustomerId,
  };
}

/**
 * ClickHouse row type for otel_traces table
 */
export type ClickHouseRow = ReturnType<typeof normalizedSpanToClickHouseRow>;
