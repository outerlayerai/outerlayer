/**
 * Structured-output model client interface for the Trace Topics pipeline.
 *
 * One injectable seam shared by the batched facet summarizer and the
 * topic namer: the caller supplies prompts plus a JSON schema, the
 * client returns the model's parsed JSON as `unknown`, and the CALLER owns
 * validation — per-field, so one malformed field degrades that field only,
 * never the whole result (the batched call preserves the per-facet design's
 * isolation guarantee).
 *
 * Production: `GeminiRestClient`. Tests/local/e2e: `MockTopicsModelClient`.
 * No AI-SDK dependency in this package, same as Stages 2–3.
 */

/** Request for one structured-output generation call. */
export interface StructuredGenerateRequest {
  /** System-level instructions (the tuned facet/naming prompts). */
  systemPrompt: string;
  /** User-facing content — preprocessed trace text or cluster exemplars. */
  userPrompt: string;
  /** Model identifier, e.g. `gemini-2.5-flash-lite`. */
  model: string;
  /**
   * JSON Schema (OpenAPI-subset, as Gemini's `responseSchema` expects) the
   * model output must conform to. Clients pass it to the provider's
   * structured-output mode; they do NOT validate against it — callers do.
   */
  responseSchema: Record<string, unknown>;
}

/** Injectable structured-output client. */
export interface StructuredModelClient {
  /**
   * Generate a JSON object. Resolves with the parsed value (`unknown` —
   * the caller validates shape) or rejects on transport/model failure.
   */
  generateObject(request: StructuredGenerateRequest): Promise<unknown>;
}
