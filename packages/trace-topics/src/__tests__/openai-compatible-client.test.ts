import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  OpenAICompatibleClient,
  OpenAICompatibleApiError,
  isRetryableModelErrorMessage,
} from '../openai-compatible-client';
import { GeminiApiError } from '../gemini-rest-client';

describe('isRetryableModelErrorMessage', () => {
  test('classifies the REAL error strings both API clients produce', () => {
    // Constructed through the actual error classes so a message-format change
    // breaks this test instead of silently breaking retry classification.
    expect(
      isRetryableModelErrorMessage(
        new OpenAICompatibleApiError(429, 'chat/completions', 'rate limited').message,
      ),
    ).toBe(true);
    expect(
      isRetryableModelErrorMessage(
        new OpenAICompatibleApiError(503, 'embeddings', 'overloaded').message,
      ),
    ).toBe(true);
    expect(
      isRetryableModelErrorMessage(
        new GeminiApiError(500, 'generateContent', 'internal').message,
      ),
    ).toBe(true);
    // Client-side errors are deterministic — retrying replays the failure.
    expect(
      isRetryableModelErrorMessage(
        new OpenAICompatibleApiError(400, 'chat/completions', 'bad request').message,
      ),
    ).toBe(false);
    expect(
      isRetryableModelErrorMessage(
        new OpenAICompatibleApiError(401, 'chat/completions', 'bad key').message,
      ),
    ).toBe(false);
  });

  test('classifies timeout and transport failures as transient', () => {
    // The raceWithTimeout rejection format (see post()).
    expect(
      isRetryableModelErrorMessage(
        'OpenAI-compatible chat/completions timed out after 65000ms (hard bound)',
      ),
    ).toBe(true);
    // AbortSignal.timeout DOMException phrasing.
    expect(isRetryableModelErrorMessage('The operation was aborted due to timeout')).toBe(true);
    // workerd/undici transport phrasing.
    expect(isRetryableModelErrorMessage('fetch failed')).toBe(true);
    // Wrapped capture (the embedding failure rows prefix the inner message).
    expect(
      isRetryableModelErrorMessage(
        'embedding_failed: OpenAI-compatible embeddings failed with HTTP 429: slow down',
      ),
    ).toBe(true);
  });

  test('treats parse/validation failures as deterministic', () => {
    expect(
      isRetryableModelErrorMessage(
        'OpenAI-compatible chat/completions returned no message content (finish_reason: length)',
      ),
    ).toBe(false);
    expect(
      isRetryableModelErrorMessage(
        'OpenAI-compatible chat/completions returned non-JSON content (first 120 chars): sure! here is',
      ),
    ).toBe(false);
    expect(isRetryableModelErrorMessage('sentiment: missing label')).toBe(false);
  });
});

/** Minimal fetch Response stand-in the client walks (ok/status/json/text). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function chatBody(content: string) {
  return { choices: [{ message: { content }, finish_reason: 'stop' }] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenAICompatibleClient.generateObject', () => {
  test('POSTs chat/completions with bearer auth + json_object and parses content', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse(chatBody('{"task":{"summary":"did a thing"}}')),
    );
    const client = new OpenAICompatibleClient({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com/v1',
      fetchFn,
    });

    const result = await client.generateObject({
      systemPrompt: 'produce JSON',
      userPrompt: 'TRACE',
      model: 'gpt-4o-mini',
      responseSchema: { type: 'object' },
    });

    expect(result).toEqual({ task: { summary: 'did a thing' } });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const sent = JSON.parse(init!.body as string);
    expect(sent.model).toBe('gpt-4o-mini');
    expect(sent.response_format).toEqual({ type: 'json_object' });
    // No temperature is sent — the GPT-5 family 400s on any non-default value.
    expect('temperature' in sent).toBe(false);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'produce JSON' },
      { role: 'user', content: 'TRACE' },
    ]);
  });

  test('tolerates a ```json fenced body', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(chatBody('```json\n{"ok":true}\n```')),
    );
    const client = new OpenAICompatibleClient({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      fetchFn,
    });
    expect(
      await client.generateObject({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'm',
        responseSchema: {},
      }),
    ).toEqual({ ok: true });
  });

  test('throws with the HTTP status on a persistent server error (after one retry)', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'boom' }, 500));
    const client = new OpenAICompatibleClient({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      fetchFn,
    });

    const promise = client
      .generateObject({ systemPrompt: 's', userPrompt: 'u', model: 'm', responseSchema: {} })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const error = await promise;

    expect(error).toBeInstanceOf(OpenAICompatibleApiError);
    expect((error as OpenAICompatibleApiError).status).toBe(500);
    expect(fetchFn).toHaveBeenCalledTimes(2); // original + one retry
  });

  test('retries once on 429 then succeeds', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate' }, 429))
      .mockResolvedValueOnce(jsonResponse(chatBody('{"v":1}')));
    const client = new OpenAICompatibleClient({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      fetchFn,
    });

    const promise = client.generateObject({
      systemPrompt: 's',
      userPrompt: 'u',
      model: 'm',
      responseSchema: {},
    });
    await vi.runAllTimersAsync();

    expect(await promise).toEqual({ v: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('OpenAICompatibleClient.embed', () => {
  test('POSTs /embeddings, sends dimensions when configured, returns a unit vector', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ embedding: [3, 4] }] }),
    );
    const client = new OpenAICompatibleClient({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      embeddingDimensions: 1024,
      fetchFn,
    });

    const result = await client.embed({ input: 'hello', model: 'emb', dimension: 1024 });

    // L2-normalized: [3,4] → [0.6, 0.8].
    expect(result.embedding[0]).toBeCloseTo(0.6, 10);
    expect(result.embedding[1]).toBeCloseTo(0.8, 10);
    expect(result.modelVersion).toBe('emb');

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://x/v1/embeddings');
    const sent = JSON.parse(init!.body as string);
    expect(sent).toEqual({ model: 'emb', input: 'hello', dimensions: 1024 });
  });

  test('omits dimensions when not configured (fixed-dim providers reject it)', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ embedding: [1, 0] }] }),
    );
    const client = new OpenAICompatibleClient({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      fetchFn,
    });

    await client.embed({ input: 'hi', model: 'mistral-embed', dimension: 1024 });

    const sent = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(sent).toEqual({ model: 'mistral-embed', input: 'hi' });
    expect('dimensions' in sent).toBe(false);
  });

  test('throws on a non-numeric embedding payload', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ data: [{ embedding: ['nope'] }] }),
    );
    const client = new OpenAICompatibleClient({
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      fetchFn,
    });
    await expect(
      client.embed({ input: 'x', model: 'm', dimension: 1 }),
    ).rejects.toThrow(/non-numeric/i);
  });
});

describe('hard timeout race', () => {
  it('rejects a request whose fetch NEVER settles — a hung subrequest must not wedge the caller', async () => {
    vi.useFakeTimers();
    try {
      const hangingFetch = vi.fn(() => new Promise<Response>(() => {}));
      const client = new OpenAICompatibleClient({
        apiKey: 'k',
        baseUrl: 'https://api.test/v1',
        fetchFn: hangingFetch as unknown as typeof fetch,
      });
      const pending = client
        .generateObject({ systemPrompt: 's', userPrompt: 'u', model: 'm', responseSchema: {} })
        .then(
          () => 'resolved',
          (e: Error) => e.message,
        );
      await vi.advanceTimersByTimeAsync(66_000);
      // AbortSignal.timeout is inert in some runtimes (observed on Workers):
      // the race is the guarantee that the caller gets an ERROR it can turn
      // into a terminal row instead of an invisible, forever-stalled tick.
      await expect(pending).resolves.toContain('timed out after 65000ms (hard bound)');
    } finally {
      vi.useRealTimers();
    }
  });
});
