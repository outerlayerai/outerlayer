/**
 * Model-client selection for the Trace Topics pipeline.
 *
 * One factory shared by every runtime that needs the pipeline's two model
 * seams (gateway enrichment cron, dashboard topic generation). The provider is
 * config-selected so switching vendors — when one rate-limits, prices, or
 * outages us — is an env change, never a code change:
 *
 *   TOPICS_MODEL_PROVIDER = gemini | openai | mistral   (default: gemini)
 *   TOPICS_MODEL_API_KEY  = <key>                       (gemini falls back to GEMINI_API_KEY)
 *   TOPICS_MODEL_BASE_URL = <override>                  (openai-compatible only)
 *   TOPICS_FACET_MODEL / TOPICS_EMBEDDING_MODEL / TOPICS_NAMING_MODEL / TOPICS_EMBEDDING_DIMENSION
 *
 * `openai` and `mistral` share one OpenAI-compatible client, so any provider
 * exposing that API shape (Together, Groq, DeepSeek, OpenRouter, a gateway…)
 * works by pointing TOPICS_MODEL_BASE_URL at it with provider=openai.
 *
 * Mock stays an EXPLICIT opt-in (TOPICS_MOCK_MODEL=true) — never a silent
 * fallback. A missing key selects the mock otherwise, and enrichment then
 * persists fabricated summaries/embeddings that loop-prevention makes
 * permanent. Fail loudly so a misconfig is caught at first use.
 */

import type { EmbeddingClient } from './facet-embedder';
import type { StructuredModelClient } from './structured-model-client';
import { GeminiRestClient } from './gemini-rest-client';
import { OpenAICompatibleClient } from './openai-compatible-client';
import { MockTopicsModelClient } from './mock-topics-client';

/** Selectable model providers (plus the explicit-opt-in mock). */
export type TopicsProvider = 'gemini' | 'openai' | 'mistral' | 'mock';

/** Env slice the factory reads — structural so any runtime's env fits. */
export interface TopicsModelEnv {
  TOPICS_MODEL_PROVIDER?: string;
  TOPICS_MODEL_API_KEY?: string;
  TOPICS_MODEL_BASE_URL?: string;
  TOPICS_FACET_MODEL?: string;
  TOPICS_EMBEDDING_MODEL?: string;
  TOPICS_NAMING_MODEL?: string;
  TOPICS_EMBEDDING_DIMENSION?: string;
  GEMINI_API_KEY?: string;
  TOPICS_MOCK_MODEL?: string;
}

/** Resolved model names + dimension the pipeline should use for a provider. */
export interface TopicsModelSelection {
  provider: TopicsProvider;
  facetModel: string;
  embeddingModel: string;
  namingModel: string;
  embeddingDimension: number;
}

/** Both model seams plus the resolved selection, for one real/mock instance. */
export interface TopicsModelClients {
  structured: StructuredModelClient;
  embedding: EmbeddingClient;
  /** Which provider was selected — logged by callers for diagnosis. */
  mode: TopicsProvider;
  /** Resolved model names + dimension callers must use with these clients. */
  models: TopicsModelSelection;
}

interface ProviderDefaults {
  baseUrl?: string;
  facetModel: string;
  embeddingModel: string;
  namingModel: string;
  embeddingDimension: number;
  /** Whether the embeddings request should send an explicit `dimensions`. */
  sendEmbeddingDimensions: boolean;
}

/**
 * Per-provider defaults. Every provider targets a 1024-dim embedding so the
 * clustering/classification space stays consistent across a provider switch;
 * override individually via env only if you know what you're doing (mixing
 * embedding models in one space is invalid).
 */
const PROVIDER_DEFAULTS: Record<
  Exclude<TopicsProvider, 'mock'>,
  ProviderDefaults
> = {
  gemini: {
    facetModel: 'gemini-2.5-flash-lite',
    embeddingModel: 'gemini-embedding-001',
    namingModel: 'gemini-2.5-flash-lite',
    embeddingDimension: 1024,
    sendEmbeddingDimensions: true,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    // gpt-5-nano: cheapest on the input dimension that dominates this
    // large-input/tiny-output task, and its 400K context keeps a ~128k
    // transcript in the reliable region (advertised windows overstate usable
    // length). Override per-facet with TOPICS_FACET_MODEL / TOPICS_NAMING_MODEL.
    facetModel: 'gpt-5-nano',
    embeddingModel: 'text-embedding-3-small',
    namingModel: 'gpt-5-nano',
    embeddingDimension: 1024,
    // text-embedding-3-* default to 1536; ask for 1024 explicitly.
    sendEmbeddingDimensions: true,
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    facetModel: 'mistral-small-latest',
    embeddingModel: 'mistral-embed',
    namingModel: 'mistral-small-latest',
    embeddingDimension: 1024,
    // mistral-embed is natively 1024 and rejects a `dimensions` field.
    sendEmbeddingDimensions: false,
  },
};

function parseProvider(raw: string | undefined): Exclude<TopicsProvider, 'mock'> {
  // Default to gemini for back-compat (a bare GEMINI_API_KEY keeps working with
  // no TOPICS_MODEL_PROVIDER set); the key is then required downstream.
  if (raw === undefined || raw === '') return 'gemini';
  if (raw === 'gemini' || raw === 'openai' || raw === 'mistral') return raw;
  throw new Error(
    `Trace Topics: unknown TOPICS_MODEL_PROVIDER "${raw}" — expected gemini | openai | mistral.`,
  );
}

/**
 * Resolve the provider's model names + embedding dimension from env, with
 * per-facet overrides. Pure (no key needed) so config-only callers — the
 * gateway's resolveTopicsConfig, the dashboard generation query — can share
 * exactly the values the clients will use.
 */
export function resolveTopicsModelSelection(
  env: TopicsModelEnv,
): TopicsModelSelection {
  if (env.TOPICS_MOCK_MODEL === 'true') {
    const d = PROVIDER_DEFAULTS.gemini;
    return {
      provider: 'mock',
      facetModel: env.TOPICS_FACET_MODEL ?? d.facetModel,
      embeddingModel: env.TOPICS_EMBEDDING_MODEL ?? d.embeddingModel,
      namingModel: env.TOPICS_NAMING_MODEL ?? d.namingModel,
      embeddingDimension: parseDimension(env.TOPICS_EMBEDDING_DIMENSION, d.embeddingDimension),
    };
  }

  const provider = parseProvider(env.TOPICS_MODEL_PROVIDER);
  const d = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    facetModel: env.TOPICS_FACET_MODEL ?? d.facetModel,
    embeddingModel: env.TOPICS_EMBEDDING_MODEL ?? d.embeddingModel,
    namingModel: env.TOPICS_NAMING_MODEL ?? d.namingModel,
    embeddingDimension: parseDimension(env.TOPICS_EMBEDDING_DIMENSION, d.embeddingDimension),
  };
}

function parseDimension(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Chat-completions coordinates for the configured provider, for callers that
 * need plain text from the SAME provider/key the topics stack uses (e.g. the
 * findings error-theme labeler) rather than structured output. Null — never a
 * throw — when the provider has no OpenAI-compatible chat endpoint (gemini,
 * mock) or no key is set: such callers treat text generation as optional.
 * Uses the naming-tier model: labeling clusters is the same
 * cheap-classification shape as naming them.
 */
export function resolveTopicsChatCompletions(
  env: TopicsModelEnv,
): { baseUrl: string; apiKey: string; model: string } | null {
  const selection = resolveTopicsModelSelection(env);
  if (selection.provider !== 'openai' && selection.provider !== 'mistral') {
    return null;
  }
  const apiKey = env.TOPICS_MODEL_API_KEY;
  if (!apiKey) return null;
  return {
    baseUrl: env.TOPICS_MODEL_BASE_URL || PROVIDER_DEFAULTS[selection.provider].baseUrl!,
    apiKey,
    model: selection.namingModel,
  };
}

export function createTopicsModelClientsFromEnv(
  env: TopicsModelEnv,
): TopicsModelClients {
  const selection = resolveTopicsModelSelection(env);

  if (selection.provider === 'mock') {
    const mock = new MockTopicsModelClient();
    return { structured: mock, embedding: mock, mode: 'mock', models: selection };
  }

  if (selection.provider === 'gemini') {
    const apiKey = env.TOPICS_MODEL_API_KEY || env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'Trace Topics: provider gemini needs GEMINI_API_KEY (or TOPICS_MODEL_API_KEY). ' +
          'Set TOPICS_MOCK_MODEL=true to explicitly opt into the deterministic mock.',
      );
    }
    const client = new GeminiRestClient({ apiKey });
    return { structured: client, embedding: client, mode: 'gemini', models: selection };
  }

  // openai | mistral — one OpenAI-compatible client.
  const defaults = PROVIDER_DEFAULTS[selection.provider];
  const apiKey = env.TOPICS_MODEL_API_KEY;
  if (!apiKey) {
    throw new Error(
      `Trace Topics: provider ${selection.provider} needs TOPICS_MODEL_API_KEY.`,
    );
  }
  const baseUrl = env.TOPICS_MODEL_BASE_URL || defaults.baseUrl!;
  const client = new OpenAICompatibleClient({
    apiKey,
    baseUrl,
    embeddingDimensions: defaults.sendEmbeddingDimensions
      ? selection.embeddingDimension
      : undefined,
  });
  return {
    structured: client,
    embedding: client,
    mode: selection.provider,
    models: selection,
  };
}
