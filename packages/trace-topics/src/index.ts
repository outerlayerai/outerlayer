// @repo/trace-topics — Trace Topics pipeline
// Stage 1: preprocessor · Stage 2: facet summarization (data-driven core +
// per-facet + batched) · Stage 3: facet embeddings · Stage 4 support:
// classification, reconciliation, naming · model clients · vector math.
export * from './trace-preprocessor';
export * from './facet-summarizer';
export * from './facet-embedder';
export * from './facet-batch-summarizer';
// Data-driven facet core (built-in + custom facets). SENTIMENT_LABELS /
// SentimentLabel are intentionally NOT re-exported here — they already reach
// the barrel via './facet-batch-summarizer' — to avoid an `export *` collision.
export {
  BATCHED_EXTRACTOR_VERSION,
  BUILTIN_FACET_SPECS,
  FACET_NONE_SENTINEL,
  TASK_FACET,
  SENTIMENT_FACET,
  ISSUES_FACET,
  FACET_PROMPT_PREAMBLE,
  isFacetNoneSentinel,
  buildFacetResponseSchema,
  buildFacetSystemPrompt,
  generateFacetBlock,
  validateFacetField,
  summarizeFacetSpecs,
  toFacetSummary,
  type FacetSpec,
  type FacetField,
  type FacetFieldOk,
  type FacetFieldError,
  type SummarizeFacetSpecsOptions,
} from './facet-definition';
export * from './steering-facet';
export * from './trivial-session';
export * from './structured-model-client';
export * from './client-factory';
export * from './gemini-rest-client';
export * from './openai-compatible-client';
export * from './mock-topics-client';
export * from './topic-classifier';
export * from './topic-reconciler';
export * from './topic-namer';
export * from './vector-math';
