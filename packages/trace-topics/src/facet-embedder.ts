/**
 * Facet Embedder — Stage 3 of the Trace Topics pipeline.
 *
 * Pure function: per-facet summary strings → dense embedding vectors.
 * No direct provider SDK calls, no storage writes, no I/O beyond the
 * injected EmbeddingClient (which the caller wires to the OuterLayer Gateway
 * in production and mocks in tests).
 *
 * Design decisions:
 * - Injectable EmbeddingClient so this package carries no AI-SDK dependency.
 *   The Gateway call is the caller's responsibility; the model is a forwarded
 *   parameter — swapping it is a one-line config change (AC2).
 * - Promise.allSettled for per-item isolation: one bad embedding does not
 *   sink the batch. Every input id always produces exactly one result entry (AC4).
 * - Schema-validates the returned embedding: must be a non-empty array of
 *   finite numbers with length === configured dimension. NaN/Infinity are
 *   treated as invalid (they would silently corrupt Stage 4 clustering).
 * - Model version is recorded on each ok result (AC3). When the Gateway reports
 *   `modelVersion`, that resolved string is used; otherwise the configured
 *   model string is the attribution. This ensures every vector is traceable
 *   to the model that produced it.
 * - Persistence is deliberately out of scope (per the issue's open dependency
 *   on whether to use ClickHouse vs pgvector). The function returns vectors
 *   + model version as a pure value; Stage 4 owns the store.
 *
 * Core embedding stage of the Trace Topics
 * pipeline. Never publish it under any `@agentmark-ai/*` OSS package.
 */

/** Default dimension for produced embedding vectors. */
export const DEFAULT_EMBEDDING_DIMENSION = 1024;

/**
 * Default embedding model routed through the OuterLayer Gateway.
 * Gemini Embedding 001 supports a configurable output dimensionality
 * including 1024, so `dimension: 1024` is honoured at the model layer.
 */
export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * One facet summary to embed. The `id` is a stable key so callers can
 * map a returned vector back to its source summary.
 */
export interface FacetSummaryInput {
  /** Stable identifier for this facet summary (e.g. trace-id + facet key). */
  id: string;
  /** The Stage 2 facet-summary text to embed. */
  summary: string;
}

/**
 * Shape returned by the injected EmbeddingClient for a single embed call.
 * The client should report the resolved model version when the Gateway
 * surfaces it; omitting it causes the configured model string to be used.
 */
export interface EmbeddingResponse {
  /** Dense embedding vector produced by the model. */
  embedding: number[];
  /**
   * Resolved model version as reported by the Gateway or model provider.
   * When present this value overrides the configured model string on the
   * result, ensuring vectors are attributable to the exact model version.
   */
  modelVersion?: string;
}

/**
 * Injectable client — production wires the OuterLayer Gateway, tests pass
 * a mock. Keeping the client injected means this package has no AI-SDK dep.
 */
export interface EmbeddingClient {
  /**
   * Embed a single input string. The client is responsible for routing the
   * call through the Gateway with the given model and dimension.
   */
  embed(opts: {
    input: string;
    model: string;
    dimension: number;
  }): Promise<EmbeddingResponse>;
}

/** Successful embedding result for one facet summary. */
export interface FacetEmbeddingOk {
  id: string;
  status: 'ok';
  /** Dense embedding vector. */
  embedding: number[];
  /**
   * Model version recorded with this vector. Equals `response.modelVersion`
   * when the Gateway reports it, otherwise equals the configured model string.
   * Required so vectors are attributable to the model that produced them —
   * changing the model later requires re-embedding.
   */
  model: string;
  /** Configured embedding dimension (matches `embedding.length`). */
  dimension: number;
}

/** Error result for one facet summary (embedding failed or was invalid). */
export interface FacetEmbeddingError {
  id: string;
  status: 'error';
  /** Human-readable description of why this embedding failed. */
  error: string;
}

/** Discriminated union of the two possible per-item outcomes. */
export type FacetEmbeddingResult = FacetEmbeddingOk | FacetEmbeddingError;

/** Options for {@link embedFacetSummaries}. */
export interface EmbedFacetSummariesOptions {
  /** Injectable client — required. Production: Gateway client. Tests: mock. */
  client: EmbeddingClient;
  /**
   * Embedding model to request. Forwarded verbatim to the client; swapping
   * it is a one-line config change. Defaults to {@link DEFAULT_EMBEDDING_MODEL}.
   */
  model?: string;
  /**
   * Embedding dimension to request. Defaults to
   * {@link DEFAULT_EMBEDDING_DIMENSION} (1024). Also used to validate the
   * returned vector length.
   */
  dimension?: number;
}

/**
 * Thrown when the EmbeddingClient returns a response whose `embedding` field
 * fails schema validation (wrong type, wrong length, or non-finite values).
 * Caught internally by allSettled so it becomes an isolated per-item error.
 */
export class EmbeddingSchemaError extends Error {
  readonly id: string;
  readonly received: unknown;

  constructor(id: string, message: string, received: unknown) {
    super(message);
    this.name = 'EmbeddingSchemaError';
    this.id = id;
    this.received = received;
  }
}

/**
 * Embed an array of facet summaries, returning one result per input in the
 * same order. Each result is either `{ status: "ok", embedding, model,
 * dimension }` or `{ status: "error", error }`.
 *
 * - Calls `client.embed` once per summary via `Promise.allSettled` so a
 *   single failure never drops other results (AC4).
 * - Schema-validates every returned embedding (array, non-empty, finite
 *   numbers, correct length). A validation failure becomes an isolated error.
 * - Records the model version on each ok result for downstream attribution (AC3).
 * - Resolves to `[]` and never calls the client when `summaries` is empty.
 */
export async function embedFacetSummaries(
  summaries: FacetSummaryInput[],
  options: EmbedFacetSummariesOptions,
): Promise<FacetEmbeddingResult[]> {
  if (summaries.length === 0) return [];

  const resolvedModel = options.model ?? DEFAULT_EMBEDDING_MODEL;
  const resolvedDimension = options.dimension ?? DEFAULT_EMBEDDING_DIMENSION;
  const { client } = options;

  const settled = await Promise.allSettled(
    summaries.map(({ id, summary }) =>
      client
        .embed({ input: summary, model: resolvedModel, dimension: resolvedDimension })
        .then((response) => {
          validateEmbedding(id, response.embedding, resolvedDimension);
          const modelAttribution = response.modelVersion ?? resolvedModel;
          const ok: FacetEmbeddingOk = {
            id,
            status: 'ok',
            embedding: response.embedding,
            model: modelAttribution,
            dimension: resolvedDimension,
          };
          return ok;
        }),
    ),
  );

  return settled.map((result, i): FacetEmbeddingResult => {
    const input = summaries[i];
    // summaries[i] is always defined because settled.length === summaries.length
    const id = input!.id;
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // Rejected: stringify non-Error reasons so `error` is always a string.
    const reason = result.reason;
    const errorMsg =
      reason instanceof Error ? reason.message : String(reason);
    return { id, status: 'error', error: errorMsg };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a raw embedding response.
 *
 * Rules:
 * - Must be an Array.
 * - Must be non-empty.
 * - Every element must be a finite number (NaN and Infinity poison clustering).
 * - Length must equal the configured `dimension`.
 *
 * Throws {@link EmbeddingSchemaError} on any violation — the allSettled
 * wrapper above catches it and converts it to an isolated error result.
 */
function validateEmbedding(
  id: string,
  embedding: unknown,
  dimension: number,
): void {
  if (!Array.isArray(embedding)) {
    throw new EmbeddingSchemaError(
      id,
      `Embedding for id "${id}" is not an array (received ${typeof embedding})`,
      embedding,
    );
  }
  if (embedding.length === 0) {
    throw new EmbeddingSchemaError(
      id,
      `Embedding for id "${id}" is an empty array`,
      embedding,
    );
  }
  for (let i = 0; i < embedding.length; i++) {
    const el = embedding[i];
    if (typeof el !== 'number' || !Number.isFinite(el)) {
      throw new EmbeddingSchemaError(
        id,
        `Embedding for id "${id}" contains a non-finite number at index ${i} (received ${String(el)})`,
        embedding,
      );
    }
  }
  if (embedding.length !== dimension) {
    throw new EmbeddingSchemaError(
      id,
      `Embedding for id "${id}" has length ${embedding.length} but dimension ${dimension} was configured`,
      embedding,
    );
  }
}
