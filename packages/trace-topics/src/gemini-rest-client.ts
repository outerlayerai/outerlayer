/**
 * Gemini REST client — the production model client for Trace Topics.
 *
 * Direct, fetch-based calls to Google's Generative Language API. No SDK
 * dependency: the two endpoints we use (generateContent with structured
 * output, embedContent with outputDimensionality) are stable v1beta REST
 * surfaces, and staying on plain fetch keeps this package dependency-free
 * and Workers-compatible.
 *
 * Design decisions:
 * - Implements BOTH pipeline seams: `StructuredModelClient` (Stage 2 batched
 *   facets, topic naming) and `EmbeddingClient` (Stage 3).
 * - Embeddings are L2-normalized before returning: Google documents that
 *   non-3072-dimension gemini-embedding-001 output is NOT normalized, and all
 *   downstream centroid math assumes unit vectors.
 * - API key travels in the `x-goog-api-key` header, never in the URL, so it
 *   cannot leak into logs or error messages.
 * - One retry (fixed 1s backoff) on 429/5xx: enrichment marks a trace's
 *   facets as errored permanently on failure (loop prevention), so a single
 *   transient rate-limit blip should not brand traces unenrichable.
 * - `fetchFn` is injectable for tests; defaults to global fetch.
 *
 * Swapping this client for a gateway LLM-proxy-backed one later requires no
 * pipeline changes — that is the point of the injectable seams.
 */

import type { EmbeddingClient, EmbeddingResponse } from './facet-embedder';
import type {
  StructuredGenerateRequest,
  StructuredModelClient,
} from './structured-model-client';
import { l2Normalize } from './vector-math';

/** Default Generative Language API base. Overridable for tests/proxies. */
export const GEMINI_API_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';

/** Statuses worth one retry — rate limits and transient server errors. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Fixed backoff before the single retry. */
const RETRY_DELAY_MS = 1_000;

/** Per-request timeout. Facet calls on 128K-token traces can run long. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Options for {@link GeminiRestClient}. */
export interface GeminiRestClientOptions {
  /** Google AI Studio / Gemini API key. */
  apiKey: string;
  /** API base URL override (tests, proxies). Defaults to Google's v1beta. */
  baseUrl?: string;
  /** Fetch implementation override for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/** Error carrying the HTTP status for caller-side triage. Body is truncated. */
export class GeminiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    bodyExcerpt: string,
  ) {
    super(`Gemini ${endpoint} failed with HTTP ${status}: ${bodyExcerpt}`);
    this.name = 'GeminiApiError';
  }
}

export class GeminiRestClient implements StructuredModelClient, EmbeddingClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: GeminiRestClientOptions) {
    if (!options.apiKey) {
      throw new Error('GeminiRestClient requires a non-empty apiKey');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? GEMINI_API_BASE_URL).replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** StructuredModelClient — generateContent with a JSON response schema. */
  async generateObject(request: StructuredGenerateRequest): Promise<unknown> {
    const body = {
      system_instruction: { parts: [{ text: request.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: request.responseSchema,
      },
    };

    const json = await this.post(`models/${request.model}:generateContent`, body);

    const record = asRecord(json);
    const candidates = record?.['candidates'];
    const first = Array.isArray(candidates) ? asRecord(candidates[0]) : undefined;
    const content = asRecord(first?.['content']);
    const parts = content?.['parts'];
    const firstPart = Array.isArray(parts) ? asRecord(parts[0]) : undefined;
    const text = firstPart?.['text'];

    if (typeof text !== 'string' || text.length === 0) {
      throw new Error(
        `Gemini generateContent returned no text candidate (finishReason: ${String(first?.['finishReason'] ?? 'unknown')})`,
      );
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `Gemini generateContent returned non-JSON text despite responseSchema (first 120 chars): ${text.slice(0, 120)}`,
      );
    }
  }

  /** EmbeddingClient — embedContent with explicit output dimensionality. */
  async embed(opts: {
    input: string;
    model: string;
    dimension: number;
  }): Promise<EmbeddingResponse> {
    const body = {
      content: { parts: [{ text: opts.input }] },
      outputDimensionality: opts.dimension,
    };

    const json = await this.post(`models/${opts.model}:embedContent`, body);

    const record = asRecord(json);
    const embedding = asRecord(record?.['embedding']);
    const values = embedding?.['values'];

    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('Gemini embedContent returned no embedding values');
    }
    if (!values.every((v): v is number => typeof v === 'number')) {
      throw new Error('Gemini embedContent returned non-numeric embedding values');
    }

    // Non-3072-dim Gemini embeddings are not unit-length — normalize here
    // so every vector the pipeline stores or compares is already normalized.
    return { embedding: l2Normalize(values), modelVersion: opts.model };
  }

  /** POST JSON with auth header, timeout, and a single transient-error retry. */
  private async post(endpoint: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchFn(`${this.baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        return (await response.json()) as unknown;
      }

      const excerpt = (await response.text().catch(() => '')).slice(0, 300);
      if (attempt === 0 && RETRYABLE_STATUSES.has(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw new GeminiApiError(response.status, endpoint, excerpt);
    }
  }
}

/** Narrow unknown to a plain record for tolerant response walking. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
