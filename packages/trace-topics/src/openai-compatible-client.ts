/**
 * OpenAI-compatible REST client — the provider-portable model client for Trace
 * Topics. Speaks the `/chat/completions` + `/embeddings` shape that OpenAI,
 * Mistral, Together, Groq, DeepSeek, OpenRouter and most gateways expose, so a
 * new provider is a base-URL + key + model-name change, never a code change.
 *
 * Design mirrors {@link GeminiRestClient}:
 * - Implements BOTH pipeline seams (StructuredModelClient + EmbeddingClient).
 * - Structured output uses `response_format: { type: 'json_object' }` — the
 *   portable common denominator across providers. The facet/naming system
 *   prompts already spell out the exact JSON shape (and contain the word
 *   "JSON", which OpenAI's json_object mode requires), and callers validate
 *   per-field, so a stricter json_schema mode is not needed here.
 * - Embeddings are L2-normalized before returning: downstream centroid math
 *   assumes unit vectors, and not every provider returns normalized output.
 * - One retry (fixed 1s backoff) on 429/5xx, same rationale as Gemini: a
 *   transient blip must not permanently brand a trace unenrichable.
 * - API key travels in the Authorization header, never the URL.
 */

import type { EmbeddingClient, EmbeddingResponse } from './facet-embedder';
import type {
  StructuredGenerateRequest,
  StructuredModelClient,
} from './structured-model-client';
import { l2Normalize } from './vector-math';

/** Statuses worth one retry — rate limits and transient server errors. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Whether a captured model-call error message describes a TRANSIENT failure
 * (rate limit, server error, timeout, transport drop) rather than a
 * deterministic one (schema mismatch, refusal, malformed response).
 *
 * The facet summarizers never throw — they capture `error.message` strings
 * into per-facet error results, so by the time a caller decides whether a
 * failed extraction is worth re-running, the typed error is gone. This
 * classifies the STRINGS those captures produce:
 *  - `... failed with HTTP <status>: ...` — both this client and the Gemini
 *    client phrase HTTP failures this way (their ApiError constructors);
 *    retryable when the status is one this client would itself retry.
 *  - `... timed out after <n>ms (hard bound)` — the raceWithTimeout guarantee.
 *  - abort/timeout phrasing from `AbortSignal.timeout` DOMExceptions.
 *  - transport-level fetch failures (workerd/undici phrasing).
 * Anything unmatched is treated as deterministic — the caller records it
 * terminally, which is the safe default (a wrongly-terminal transient costs
 * one trace's facets; a wrongly-retried deterministic error loops forever).
 */
export function isRetryableModelErrorMessage(message: string): boolean {
  if (/failed with HTTP (?:429|500|502|503|504)\b/.test(message)) return true;
  if (/timed out after \d+ms/.test(message)) return true;
  if (/aborted due to timeout|TimeoutError/i.test(message)) return true;
  return /fetch failed|network connection|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i.test(
    message,
  );
}

/** Fixed backoff before the single retry. */
const RETRY_DELAY_MS = 1_000;

/** Per-request timeout. Facet calls on large traces can run long. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Options for {@link OpenAICompatibleClient}. */
export interface OpenAICompatibleClientOptions {
  /** Provider API key, sent as `Authorization: Bearer`. */
  apiKey: string;
  /** API base URL, e.g. `https://api.openai.com/v1`. No trailing slash needed. */
  baseUrl: string;
  /**
   * When set, sent as the `dimensions` field on embedding requests so models
   * that support output-dimension reduction (e.g. text-embedding-3-*) return
   * the pipeline's expected size. Omit for models with a fixed native
   * dimension (e.g. mistral-embed), which reject the field.
   */
  embeddingDimensions?: number;
  /** Fetch implementation override for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/** Error carrying the HTTP status for caller-side triage. Body is truncated. */
export class OpenAICompatibleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    bodyExcerpt: string,
  ) {
    super(`OpenAI-compatible ${endpoint} failed with HTTP ${status}: ${bodyExcerpt}`);
    this.name = 'OpenAICompatibleApiError';
  }
}

export class OpenAICompatibleClient
  implements StructuredModelClient, EmbeddingClient
{
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly embeddingDimensions?: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAICompatibleClientOptions) {
    if (!options.apiKey) {
      throw new Error('OpenAICompatibleClient requires a non-empty apiKey');
    }
    if (!options.baseUrl) {
      throw new Error('OpenAICompatibleClient requires a non-empty baseUrl');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.embeddingDimensions = options.embeddingDimensions;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** StructuredModelClient — chat/completions in JSON-object mode. */
  async generateObject(request: StructuredGenerateRequest): Promise<unknown> {
    const json = await this.post('chat/completions', {
      model: request.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      response_format: { type: 'json_object' },
      // No temperature override: the GPT-5 family (e.g. gpt-5-nano) rejects any
      // value other than the default 1 with a 400, and other providers are
      // fine with the default too. Facet extraction leans on the schema +
      // prompt, not low temperature, so the default is acceptable everywhere.
    });

    const record = asRecord(json);
    const choices = record?.['choices'];
    const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
    const message = asRecord(first?.['message']);
    const content = message?.['content'];

    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(
        `OpenAI-compatible chat/completions returned no message content (finish_reason: ${String(first?.['finish_reason'] ?? 'unknown')})`,
      );
    }

    try {
      return JSON.parse(stripCodeFences(content)) as unknown;
    } catch {
      throw new Error(
        `OpenAI-compatible chat/completions returned non-JSON content (first 120 chars): ${content.slice(0, 120)}`,
      );
    }
  }

  /** EmbeddingClient — /embeddings, optionally with a requested dimension. */
  async embed(opts: {
    input: string;
    model: string;
    dimension: number;
  }): Promise<EmbeddingResponse> {
    const json = await this.post('embeddings', {
      model: opts.model,
      input: opts.input,
      ...(this.embeddingDimensions !== undefined
        ? { dimensions: this.embeddingDimensions }
        : {}),
    });

    const record = asRecord(json);
    const data = record?.['data'];
    const first = Array.isArray(data) ? asRecord(data[0]) : undefined;
    const values = first?.['embedding'];

    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('OpenAI-compatible embeddings returned no embedding values');
    }
    if (!values.every((v): v is number => typeof v === 'number')) {
      throw new Error('OpenAI-compatible embeddings returned non-numeric values');
    }

    return { embedding: l2Normalize(values), modelVersion: opts.model };
  }

  /** POST JSON with auth header, timeout, and a single transient-error retry. */
  private async post(endpoint: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      // The abort signal is the polite bound; the race is the guarantee. In
      // runtimes where aborting an in-flight subrequest doesn't tear it down
      // (observed on Workers), an unbounded await here wedges the WHOLE
      // scheduled invocation until the platform kills it — no error, no row,
      // and the same candidate re-picked forever. The race converts a hung
      // request into a thrown timeout the caller's error path can record.
      const response = await raceWithTimeout(
        this.fetchFn(`${this.baseUrl}/${endpoint}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
        REQUEST_TIMEOUT_MS + 5_000,
        `OpenAI-compatible ${endpoint}`,
      );

      if (response.ok) {
        return (await response.json()) as unknown;
      }

      const excerpt = (await response.text().catch(() => '')).slice(0, 300);
      if (attempt === 0 && RETRYABLE_STATUSES.has(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw new OpenAICompatibleApiError(response.status, endpoint, excerpt);
    }
  }
}

/** Reject after `ms` even if the underlying promise never settles. */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms (hard bound)`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Some providers wrap JSON in a ```json fence despite json_object mode. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/** Narrow unknown to a plain record for tolerant response walking. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
