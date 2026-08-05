/**
 * Deterministic mock model client for Trace Topics.
 *
 * Stands in for Gemini in local dev, unit tests, and the e2e — selected when
 * no GEMINI_API_KEY is configured or TOPICS_MOCK_MODEL=true. Only the
 * PROVIDER is faked: everything downstream (UMAP/HDBSCAN in the clustering
 * service, centroids, classification, reconciliation) runs for real on the
 * vectors this client produces.
 *
 * The similarity structure is real, not random: embeddings use the classic
 * feature-hashing trick — each salient token hashes to a signed dimension,
 * token vectors sum, and the result is L2-normalized. Texts that share words
 * land near each other in cosine space, so traces seeded with repeated
 * behavioral patterns produce summaries that genuinely cluster, and HDBSCAN
 * finds them the same way it would find real topics.
 *
 * Everything is a pure function of the input text — no Date.now, no
 * randomness — so runs are byte-reproducible.
 */

import type { EmbeddingClient, EmbeddingResponse } from './facet-embedder';
import type {
  StructuredGenerateRequest,
  StructuredModelClient,
} from './structured-model-client';
import type { SentimentLabel } from './facet-batch-summarizer';
import { l2Normalize } from './vector-math';

/** Model-version string recorded on mock embeddings for attribution. */
export const MOCK_EMBEDDING_MODEL_VERSION = 'mock-feature-hash-001';

const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for',
  'from', 'handled', 'has', 'have', 'i', 'in', 'is', 'it', 'its', 'of',
  'on', 'or', 'request', 'that', 'the', 'their', 'there', 'they', 'this',
  'to', 'was', 'were', 'will', 'with', 'you', 'your',
  // Trace-rendering boilerplate — shared by every preprocessed trace, so it
  // must not contribute similarity between unrelated patterns.
  'user', 'agent', 'input', 'output', 'span', 'generation',
]);

const NEGATIVE_MARKERS = ['error', 'fail', 'failed', 'failure', 'exception', 'timeout', 'crash'];
const FRUSTRATED_MARKERS = ['frustrat', 'angry', 'annoyed', 'complain', 'unacceptable', 'again and again'];
const POSITIVE_MARKERS = ['thank', 'great', 'resolved', 'perfect', 'works now'];

export class MockTopicsModelClient implements StructuredModelClient, EmbeddingClient {
  /**
   * Route by response-schema shape: the batched facet schema has a `task`
   * property; the topic-naming schema has a `topics` property. Anything else
   * is a caller bug worth failing loudly on.
   */
  async generateObject(request: StructuredGenerateRequest): Promise<unknown> {
    const properties = asRecord(request.responseSchema['properties']);
    if (properties && 'task' in properties) {
      return mockBatchFacets(request.userPrompt);
    }
    if (properties && 'steering' in properties) {
      return mockSteering(request.userPrompt);
    }
    if (properties && 'topics' in properties) {
      return mockTopicNames(request.userPrompt);
    }
    throw new Error(
      'MockTopicsModelClient received an unrecognized responseSchema (expected batched-facets, steering, or topic-naming shape)',
    );
  }

  /** Feature-hash embedding: deterministic, similarity-preserving, unit-norm. */
  async embed(opts: {
    input: string;
    model: string;
    dimension: number;
  }): Promise<EmbeddingResponse> {
    return {
      embedding: featureHashEmbedding(opts.input, opts.dimension),
      modelVersion: MOCK_EMBEDDING_MODEL_VERSION,
    };
  }
}

/** Batched-facet mock: summaries templated from the trace's salient tokens. */
function mockBatchFacets(traceText: string): unknown {
  const tokens = salientTokens(traceText, 12);
  const subject = tokens.length > 0 ? tokens.join(' ') : 'an unspecified request';
  const lower = traceText.toLowerCase();

  const hasNegative = NEGATIVE_MARKERS.some((m) => lower.includes(m));
  const label: SentimentLabel = FRUSTRATED_MARKERS.some((m) => lower.includes(m))
    ? 'FRUSTRATED'
    : hasNegative
      ? 'NEGATIVE'
      : POSITIVE_MARKERS.some((m) => lower.includes(m))
        ? 'POSITIVE'
        : 'NEUTRAL';

  return {
    task: { summary: `The agent handled a request about ${subject}.` },
    sentiment: {
      label,
      summary: `The interaction reads as ${label.toLowerCase()} based on its wording.`,
    },
    issues: {
      // Mirrors the shipped prompt contract: nothing to report is the NONE
      // sentinel, never prose — sentinel prose was 42% of a real corpus's
      // issues facet and clustered into its top "topic".
      summary: hasNegative
        ? `The trace shows problems related to ${subject}.`
        : 'NONE',
    },
  };
}

/**
 * Steering mock: one correction per developer turn in the rendering (the
 * steering rendering is developer turns only), each a rule templated from
 * that turn's salient tokens; an empty corrections list when the rendering
 * carries no developer turn. Per-turn output makes the fan-out (one facet
 * row per correction) exercisable deterministically.
 */
function mockSteering(steeringText: string): unknown {
  const corrections = steeringText
    .split('\n')
    .filter((line) => line.startsWith('DEVELOPER: '))
    .slice(0, 8)
    .map((line) => {
      // Tokenize the developer's words only — the rendering prefix is
      // boilerplate shared by every turn and must not become the subject.
      const body = line.slice('DEVELOPER: '.length);
      const tokens = salientTokens(body, 6);
      const subject = tokens.length > 0 ? tokens.join(' ') : 'the corrected approach';
      return {
        summary: `Follow the team convention about ${subject} — "${body.slice(0, 60)}"`,
        kind: mockSteeringKind(body),
      };
    });
  return { steering: { corrections } };
}

/**
 * Deterministic kind from the developer's wording, mirroring the real
 * classifier's intent: standing-constraint language → rule, style/tool
 * language → preference, a question mark → question, anything else a
 * one-off task direction. Tests choose their fixture wording to choose the
 * kind — no randomness, no model.
 */
function mockSteeringKind(body: string): string {
  const lower = body.toLowerCase();
  if (/\b(never|always|must not|must\b|from now on)\b/.test(lower)) return 'rule';
  if (/\b(prefer|use |instead of|format|style)\b/.test(lower)) return 'preference';
  if (body.trim().endsWith('?')) return 'question';
  return 'task_direction';
}

/**
 * Topic-naming mock. The namer sends a JSON userPrompt of shape
 * `{ clusters: [{ topicId, keywords, exemplars }] }` (see topic-namer.ts);
 * names are title-cased top keywords — the same fallback naming the real
 * pipeline uses when no model is available.
 */
function mockTopicNames(userPrompt: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(userPrompt);
  } catch {
    throw new Error('MockTopicsModelClient: naming userPrompt was not JSON');
  }
  const clusters = asRecord(parsed)?.['clusters'];
  if (!Array.isArray(clusters)) {
    throw new Error('MockTopicsModelClient: naming userPrompt missing clusters[]');
  }
  return {
    topics: clusters.map((entry) => {
      const record = asRecord(entry) ?? {};
      const topicId = typeof record['topicId'] === 'string' ? record['topicId'] : '';
      const keywords = Array.isArray(record['keywords'])
        ? (record['keywords'] as unknown[]).filter(
            (k): k is string => typeof k === 'string',
          )
        : [];
      const name =
        keywords.slice(0, 3).map(titleCase).join(' ') || `Topic ${topicId}`;
      return { topicId, name, description: `Sessions about ${keywords.slice(0, 3).join(', ') || 'a shared pattern'}.` };
    }),
  };
}

// ---------------------------------------------------------------------------
// Deterministic text → vector helpers
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit — stable, dependency-free string hash. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Feature-hashing embedding: token → signed dimension via FNV-1a, summed and
 * L2-normalized. Shared vocabulary ⇒ high cosine similarity; disjoint
 * vocabulary ⇒ near-orthogonal. Zero-signal text yields the zero vector.
 */
export function featureHashEmbedding(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (const token of tokenize(text)) {
    const hash = fnv1a(token);
    const index = hash % dimension;
    const sign = (hash >>> 16) & 1 ? 1 : -1;
    vector[index] = (vector[index] as number) + sign;
  }
  return l2Normalize(vector);
}

/** Lowercased alphanumeric tokens, stopwords and 1-char tokens removed. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** First `limit` distinct salient tokens, in order of appearance. */
function salientTokens(text: string, limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(text)) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= limit) break;
  }
  return out;
}

function titleCase(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
