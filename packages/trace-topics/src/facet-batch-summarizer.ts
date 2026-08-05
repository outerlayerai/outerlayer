/**
 * Batched Facet Summarizer — Stage 2 of the Trace Topics pipeline.
 *
 * ONE structured-output LLM call per trace returns all built-in facets:
 * Task, Sentiment (enum label + summary), Issues. Batching pays the
 * expensive trace tokens once, not once per facet.
 *
 * This is now a thin, backward-compatible façade over the data-driven engine
 * in {@link ./facet-definition}: the schema and prompt are DERIVED from
 * {@link BUILTIN_FACET_SPECS}, and the batched call delegates to
 * {@link summarizeFacetSpecs}. The `{ task, sentiment, issues }`
 * return shape and the exported `BATCH_FACET_*` constants are unchanged
 * (pinned byte-for-byte by tests) so the enrichment path is untouched.
 *
 * To summarize a CUSTOM facet list (user-defined facets), call
 * {@link summarizeFacetSpecs} directly with your own {@link FacetSpec}s.
 *
 * Sentiment is an enum classification, not clustering input: its label
 * is written to `trace_facets.Label` for filtering; it is never embedded.
 *
 * Prompts here are tuned and test-pinned — behavior, not boilerplate. Not in
 * any `@agentmark-ai/*` OSS package.
 */

import {
  BUILTIN_FACET_SPECS,
  buildFacetResponseSchema,
  buildFacetSystemPrompt,
  SENTIMENT_LABELS,
  summarizeFacetSpecs,
  toFacetSummary,
  type FacetField,
  type SentimentLabel,
} from './facet-definition';
import type { FacetSummary } from './facet-summarizer';
import type { StructuredModelClient } from './structured-model-client';

// Re-exported so consumers of the batch summarizer get the sentiment
// vocabulary from the same module, without also importing facet-definition.
export { SENTIMENT_LABELS };
export type { SentimentLabel };

/** Default model routed to the provider (Gemini 2.5 Flash-Lite). */
export const DEFAULT_BATCH_FACET_MODEL = 'gemini-2.5-flash-lite';

/** Successful sentiment result — summary plus the enum label. */
export interface SentimentSummaryOk {
  facetKey: 'sentiment';
  status: 'ok';
  summary: string;
  label: SentimentLabel;
}

/** Sentiment slice of the batch result (ok with label, or isolated error). */
export type SentimentSummary =
  | SentimentSummaryOk
  | { facetKey: 'sentiment'; status: 'error'; error: string };

/** One batched call's outcome — every facet always present. */
export interface BatchFacetSummaries {
  task: FacetSummary;
  sentiment: SentimentSummary;
  issues: FacetSummary;
}

/**
 * Gemini-compatible response schema (OpenAPI subset) for the batched call.
 * Derived from the built-in facet list — structurally identical to the former
 * hand-written constant (pinned by a test).
 */
export const BATCH_FACET_RESPONSE_SCHEMA: Record<string, unknown> =
  buildFacetResponseSchema(BUILTIN_FACET_SPECS);

/**
 * Batched facet prompt. Assembled from the built-in facet blocks —
 * byte-for-byte identical to the former hand-written constant (pinned by a
 * test). The trace text is DATA: the preamble instructs the model to ignore
 * any instructions embedded in it.
 */
export const BATCH_FACET_SYSTEM_PROMPT: string =
  buildFacetSystemPrompt(BUILTIN_FACET_SPECS);

/** Options for {@link summarizeFacetsBatched}. */
export interface SummarizeFacetsBatchedOptions {
  /** Injectable structured-output client — required. */
  client: StructuredModelClient;
  /** Model identifier; defaults to {@link DEFAULT_BATCH_FACET_MODEL}. */
  model?: string;
}

/** Map the sentiment {@link FacetField} to the labelled {@link SentimentSummary}. */
function toSentimentSummary(field: FacetField): SentimentSummary {
  if (field.status === 'ok' && field.label !== undefined) {
    return {
      facetKey: 'sentiment',
      status: 'ok',
      summary: field.summary,
      label: field.label as SentimentLabel,
    };
  }
  return {
    facetKey: 'sentiment',
    status: 'error',
    error: field.status === 'error' ? field.error : "sentiment: missing label",
  };
}

/**
 * Summarize a preprocessed trace through all built-in facets in ONE call.
 *
 * - Transport/model failure → every facet reports that error.
 * - Per-field validation → a malformed field degrades only its facet.
 * - Never throws: the result always carries all three facets.
 */
export async function summarizeFacetsBatched(
  preprocessedText: string,
  options: SummarizeFacetsBatchedOptions,
): Promise<BatchFacetSummaries> {
  const model = options.model ?? DEFAULT_BATCH_FACET_MODEL;

  const fields = await summarizeFacetSpecs(preprocessedText, BUILTIN_FACET_SPECS, {
    client: options.client,
    model,
    // Pass the stable exported constants so the request is identical to the
    // former hand-written path (reference-identity, not just deep-equality).
    systemPrompt: BATCH_FACET_SYSTEM_PROMPT,
    responseSchema: BATCH_FACET_RESPONSE_SCHEMA,
  });

  return {
    task: toFacetSummary(fields['task'] as FacetField),
    sentiment: toSentimentSummary(fields['sentiment'] as FacetField),
    issues: toFacetSummary(fields['issues'] as FacetField),
  };
}
