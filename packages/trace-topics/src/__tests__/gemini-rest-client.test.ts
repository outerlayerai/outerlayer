import { describe, expect, test, vi } from 'vitest';
import { GeminiApiError, GeminiRestClient } from '../gemini-rest-client';
import { l2Norm } from '../vector-math';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const generateBody = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
});

describe('GeminiRestClient.generateObject', () => {
  test('sends structured-output request with key in header, not URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(generateBody('{"ok":true}')),
    );
    const client = new GeminiRestClient({ apiKey: 'sk-test', fetchFn });

    const result = await client.generateObject({
      systemPrompt: 'SYS',
      userPrompt: 'USER',
      model: 'gemini-2.5-flash-lite',
      responseSchema: { type: 'object' },
    });

    expect(result).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
    );
    // Key travels in the header and never appears in the URL.
    expect(url).not.toContain('sk-test');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-goog-api-key': 'sk-test',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      system_instruction: { parts: [{ text: 'SYS' }] },
      contents: [{ role: 'user', parts: [{ text: 'USER' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: { type: 'object' },
      },
    });
  });

  test('throws a descriptive error when no candidate text is returned', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ candidates: [{ finishReason: 'SAFETY' }] }),
    );
    const client = new GeminiRestClient({ apiKey: 'k', fetchFn });

    await expect(
      client.generateObject({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'm',
        responseSchema: {},
      }),
    ).rejects.toThrow('no text candidate (finishReason: SAFETY)');
  });

  test('throws when candidate text is not JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(generateBody('not json')));
    const client = new GeminiRestClient({ apiKey: 'k', fetchFn });

    await expect(
      client.generateObject({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'm',
        responseSchema: {},
      }),
    ).rejects.toThrow('non-JSON text');
  });
});

describe('GeminiRestClient.embed', () => {
  test('requests the configured dimensionality and L2-normalizes the result', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ embedding: { values: [3, 0, 4] } }),
    );
    const client = new GeminiRestClient({ apiKey: 'k', fetchFn });

    const result = await client.embed({
      input: 'summary text',
      model: 'gemini-embedding-001',
      dimension: 3,
    });

    // Raw [3,0,4] has norm 5 — the client must normalize before returning.
    expect(result).toEqual({
      embedding: [0.6, 0, 0.8],
      modelVersion: 'gemini-embedding-001',
    });
    expect(l2Norm(result.embedding)).toBeCloseTo(1, 12);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      content: { parts: [{ text: 'summary text' }] },
      outputDimensionality: 3,
    });
  });

  test('rejects on missing or non-numeric embedding values', async () => {
    const client1 = new GeminiRestClient({
      apiKey: 'k',
      fetchFn: vi.fn().mockResolvedValue(jsonResponse({ embedding: { values: [] } })),
    });
    await expect(
      client1.embed({ input: 't', model: 'm', dimension: 3 }),
    ).rejects.toThrow('no embedding values');

    const client2 = new GeminiRestClient({
      apiKey: 'k',
      fetchFn: vi
        .fn()
        .mockResolvedValue(jsonResponse({ embedding: { values: [1, 'x', 3] } })),
    });
    await expect(
      client2.embed({ input: 't', model: 'm', dimension: 3 }),
    ).rejects.toThrow('non-numeric');
  });
});

describe('GeminiRestClient transport', () => {
  test('retries exactly once on 429 then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
        .mockResolvedValueOnce(jsonResponse(generateBody('{"ok":1}')));
      const client = new GeminiRestClient({ apiKey: 'k', fetchFn });

      const pending = client.generateObject({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'm',
        responseSchema: {},
      });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual({ ok: 1 });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does NOT retry a 400 — fails immediately with status and endpoint', async () => {
    // Fresh Response per call: a Response body is single-use.
    const fetchFn = vi
      .fn()
      .mockImplementation(async () => new Response('bad schema', { status: 400 }));
    const client = new GeminiRestClient({ apiKey: 'k', fetchFn });

    await expect(
      client.generateObject({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'm',
        responseSchema: {},
      }),
    ).rejects.toThrow('Gemini models/m:generateContent failed with HTTP 400: bad schema');
    expect(fetchFn).toHaveBeenCalledTimes(1); // no retry on 4xx
  });

  test('gives up after the single retry on persistent 503', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(new Response('unavailable', { status: 503 }));
      const client = new GeminiRestClient({ apiKey: 'k', fetchFn });

      const pending = client
        .generateObject({
          systemPrompt: 's',
          userPrompt: 'u',
          model: 'm',
          responseSchema: {},
        })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_000);

      const error = await pending;
      expect(error).toBeInstanceOf(GeminiApiError);
      expect((error as GeminiApiError).status).toBe(503);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('constructor rejects an empty API key', () => {
    expect(() => new GeminiRestClient({ apiKey: '' })).toThrow(
      'GeminiRestClient requires a non-empty apiKey',
    );
  });
});
