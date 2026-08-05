/**
 * Facet Summarizer — Stage 2 of the Trace Topics pipeline.
 *
 * Consumes preprocessed trace text from Stage 1 (`preprocessTraceToText` in
 * `@repo/trace-topics`) and produces short per-facet summaries via
 * a fast, cheap LLM routed through the OuterLayer Gateway.
 *
 * Design decisions:
 * - One call per facet, settled in parallel via `Promise.allSettled` so a
 *   single facet failure cannot cancel the others (AC4).
 * - `FacetModelClient` is an injectable interface; production callers supply
 *   a Gateway-backed implementation; tests supply a mock.  No AI SDK dependency
 *   in this package (AC2).
 * - Facet prompts (Task, Sentiment, Issues) are tuned + test-pinned; not to be
 *   published in any `@agentmark-ai/*` OSS package.
 * - Structured output is the single source of truth; no raw-string matching
 *   (AC3).
 */

/** Default model routed through the Gateway (Gemini 2.5 Flash-Lite). */
export const DEFAULT_FACET_MODEL = 'gemini-2.5-flash-lite';

// ---------------------------------------------------------------------------
// Facet model client interface (dependency-injectable)
// ---------------------------------------------------------------------------

/**
 * Request sent to the model client for a single facet.
 */
export interface FacetModelRequest {
  /** System-level instructions for the model. */
  systemPrompt: string;
  /** The user-facing content: preprocessed trace text. */
  userPrompt: string;
  /** Model identifier; consumers default to {@link DEFAULT_FACET_MODEL}. */
  model: string;
}

/**
 * Structured model response for a single facet call.
 * The model MUST return this shape; raw strings are never accepted (AC3).
 */
export interface FacetModelResponse {
  /** Short prose summary of the trace through the facet's lens. */
  summary: string;
}

/**
 * Minimal injectable interface for calling a language model.
 *
 * Production implementations route through the OuterLayer Gateway (AC2).
 * Test implementations return canned responses.
 */
export interface FacetModelClient {
  call(request: FacetModelRequest): Promise<FacetModelResponse>;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when the model response does not conform to {@link FacetModelResponse}.
 */
export class FacetSchemaError extends Error {
  constructor(
    public readonly facetKey: string,
    public readonly received: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'FacetSchemaError';
  }
}

// ---------------------------------------------------------------------------
// Facet definitions (tuned wording, pinned by tests)
// ---------------------------------------------------------------------------

/**
 * A single facet definition used by the summarizer.
 */
export interface FacetDefinition {
  /** Stable identifier used in output (e.g. `'task'`). */
  key: string;
  /** Short human-readable name. */
  name: string;
  /** System prompt instructing the model how to summarize through this lens. */
  systemPrompt: string;
}

/**
 * Built-in facets for the Trace Topics pipeline.
 *
 * These prompts are tuned and test-pinned; edits change what every trace is summarized with, not just
 * any `@agentmark-ai/*` OSS package.
 */
export const BUILTIN_FACETS: readonly FacetDefinition[] = [
  {
    key: 'task',
    name: 'Task',
    systemPrompt:
      'You are a trace analyst. Your job is to summarize what task or goal the AI agent was trying to accomplish in this trace. Focus on the objective, not implementation details. Respond with a JSON object: {"summary": "<one or two concise sentences describing the task>"}.',
  },
  {
    key: 'sentiment',
    name: 'Sentiment',
    systemPrompt:
      'You are a trace analyst. Your job is to assess the overall sentiment and outcome of this AI agent interaction — was it successful, frustrated, confused, or otherwise? Respond with a JSON object: {"summary": "<one or two concise sentences describing the sentiment and outcome>"}.',
  },
  {
    key: 'issues',
    name: 'Issues',
    systemPrompt:
      'You are a trace analyst. Your job is to identify any errors, failures, or notable problems that occurred during this AI agent trace. If there are none, state that explicitly. Respond with a JSON object: {"summary": "<one or two concise sentences listing notable issues, or stating none were found>"}.',
  },
];

// ---------------------------------------------------------------------------
// Summarizer output types
// ---------------------------------------------------------------------------

/** A successfully produced facet summary. */
export interface FacetSummaryResult {
  facetKey: string;
  status: 'ok';
  summary: string;
}

/** A facet summary that failed due to a model or schema error. */
export interface FacetSummaryError {
  facetKey: string;
  status: 'error';
  error: string;
}

/** Union of all possible per-facet results. */
export type FacetSummary = FacetSummaryResult | FacetSummaryError;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link summarizeFacets}. */
export interface SummarizeFacetsOptions {
  /**
   * Model identifier to pass to the client.
   * Defaults to {@link DEFAULT_FACET_MODEL}.
   */
  model?: string;
  /**
   * Facet model client.  Production callers supply a Gateway-backed client;
   * test callers supply a mock.  If omitted, callers MUST have set a module-
   * level default (unusual in tests).
   */
  client: FacetModelClient;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Summarize preprocessed trace text through a set of facets.
 *
 * Calls the {@link FacetModelClient} once per enabled facet (in parallel)
 * and returns one {@link FacetSummary} per facet in input order.  A per-facet
 * failure returns `{ status: 'error' }` without cancelling the others (AC4).
 *
 * @param preprocessedText - Output of Stage 1 `preprocessTraceToText()`.
 * @param facets - Array of facet definitions; defaults to {@link BUILTIN_FACETS}.
 * @param options - Model/client configuration.
 * @returns Array of summaries in the same order as `facets`.
 */
export async function summarizeFacets(
  preprocessedText: string,
  facets: readonly FacetDefinition[],
  options: SummarizeFacetsOptions,
): Promise<FacetSummary[]> {
  const model = options.model ?? DEFAULT_FACET_MODEL;
  const { client } = options;

  // Fire all facet calls concurrently; allSettled guarantees no cancellation
  // across facets even if one rejects (AC4).
  const settled = await Promise.allSettled(
    facets.map((facet) =>
      callFacet(client, facet, preprocessedText, model),
    ),
  );

  return settled.map((result, i) => {
    const facet = facets[i]!;
    if (result.status === 'fulfilled') {
      return result.value;
    }
    const err = result.reason;
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { facetKey: facet.key, status: 'error' as const, error: errorMsg };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Execute a single facet call and validate the response shape.
 *
 * Throws {@link FacetSchemaError} when the model response is structurally
 * invalid (AC3).
 */
async function callFacet(
  client: FacetModelClient,
  facet: FacetDefinition,
  userPrompt: string,
  model: string,
): Promise<FacetSummaryResult> {
  const response = await client.call({
    systemPrompt: facet.systemPrompt,
    userPrompt,
    model,
  });

  // Validate structured output — never accept raw string matching (AC3).
  if (
    response === null ||
    typeof response !== 'object' ||
    typeof (response as FacetModelResponse).summary !== 'string'
  ) {
    throw new FacetSchemaError(
      facet.key,
      response,
      `Facet '${facet.key}' returned invalid response: expected { summary: string }, got ${JSON.stringify(response)}`,
    );
  }

  return {
    facetKey: facet.key,
    status: 'ok',
    summary: (response as FacetModelResponse).summary,
  };
}
