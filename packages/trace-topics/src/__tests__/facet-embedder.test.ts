/**
 * Pins the facet-embedder pure function (Topics Stage 3).
 *
 * Each test targets a specific bug class; the smallest production-code change
 * that could still pass all tests would break at least one assertion here.
 *
 * All embedding calls use a mocked EmbeddingClient — no live model calls,
 * no I/O, no storage. Gateway routing is verified by asserting what arguments
 * the mock client receives, not by connecting to a real network.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  embedFacetSummaries,
  DEFAULT_EMBEDDING_DIMENSION,
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingSchemaError,
  type EmbeddingClient,
  type EmbeddingResponse,
  type FacetSummaryInput,
} from '../facet-embedder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a canned embedding vector of the given length filled with fractional steps. */
function makeVector(length: number): number[] {
  return Array.from({ length }, (_, i) => (i + 1) / (length + 1));
}

/** Build a mock EmbeddingClient that always returns a vector matching the requested dimension. */
function makeMockClient(
  modelVersion?: string,
): { client: EmbeddingClient; embedSpy: ReturnType<typeof vi.fn> } {
  const embedSpy = vi.fn<
    (opts: { input: string; model: string; dimension: number }) => Promise<EmbeddingResponse>
  >().mockImplementation(async ({ dimension: d }) => {
    const resp: EmbeddingResponse = { embedding: makeVector(d) };
    if (modelVersion !== undefined) resp.modelVersion = modelVersion;
    return resp;
  });
  return { client: { embed: embedSpy }, embedSpy };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUMMARIES: FacetSummaryInput[] = [
  { id: 'facet-a', summary: 'Agent executed a web search for product pricing.' },
  { id: 'facet-b', summary: 'Agent summarized findings into a concise report.' },
  { id: 'facet-c', summary: 'Agent encountered a tool timeout and retried.' },
];

// ---------------------------------------------------------------------------
// 1. One vector per summary, in order
// ---------------------------------------------------------------------------

describe('embedFacetSummaries — one result per input, in order', () => {
  it('returns exactly N results for N inputs', async () => {
    const { client } = makeMockClient();
    const results = await embedFacetSummaries(SUMMARIES, { client });
    expect(results).toHaveLength(SUMMARIES.length);
  });

  it('result ids match input ids positionally (no drop, no reorder)', async () => {
    const { client } = makeMockClient();
    const results = await embedFacetSummaries(SUMMARIES, { client });
    expect(results.map((r) => r.id)).toEqual(SUMMARIES.map((s) => s.id));
  });

  it('all results are ok when the client succeeds', async () => {
    const { client } = makeMockClient();
    const results = await embedFacetSummaries(SUMMARIES, { client });
    for (const r of results) {
      expect(r.status).toBe('ok');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Dimension contract
// ---------------------------------------------------------------------------

describe('embedFacetSummaries — dimension contract', () => {
  it('ok result embedding has length 1024 by default', async () => {
    const { client } = makeMockClient();
    const results = await embedFacetSummaries([SUMMARIES[0]!], { client });
    const result = results[0]!;
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.embedding).toHaveLength(1024);
      expect(result.dimension).toBe(1024);
    }
  });

  it('honours a custom dimension option (256)', async () => {
    const { client } = makeMockClient();
    const results = await embedFacetSummaries([SUMMARIES[0]!], {
      client,
      dimension: 256,
    });
    const result = results[0]!;
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.embedding).toHaveLength(256);
      expect(result.dimension).toBe(256);
    }
  });

  it('wrong-length vector → isolated error result, not a throw', async () => {
    // Client returns a 512-element vector but 1024 was configured.
    const embedSpy = vi.fn<
      (opts: { input: string; model: string; dimension: number }) => Promise<EmbeddingResponse>
    >().mockResolvedValue({ embedding: makeVector(512) });
    const client: EmbeddingClient = { embed: embedSpy };

    const results = await embedFacetSummaries([SUMMARIES[0]!], { client });
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toContain(SUMMARIES[0]!.id);
      expect(result.error).toContain('dimension');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Non-numeric / NaN / non-array embedding → isolated error
// ---------------------------------------------------------------------------

describe('embedFacetSummaries — schema validation (non-numeric vectors)', () => {
  it('non-array embedding → isolated error, not a top-level throw', async () => {
    const embedSpy = vi.fn().mockResolvedValue({ embedding: 'nope' });
    const client: EmbeddingClient = { embed: embedSpy };

    const results = await embedFacetSummaries([SUMMARIES[0]!], { client });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('error');
  });

  it('embedding with a non-numeric element → isolated error', async () => {
    const embedSpy = vi.fn().mockResolvedValue({
      embedding: [1, 'x', 3, ...makeVector(1021)],
    });
    const client: EmbeddingClient = { embed: embedSpy };

    const results = await embedFacetSummaries([SUMMARIES[0]!], { client });
    expect(results[0]!.status).toBe('error');
  });

  it('embedding with NaN → isolated error (NaN poisons clustering)', async () => {
    const vec = makeVector(1024);
    vec[5] = NaN;
    const embedSpy = vi.fn().mockResolvedValue({ embedding: vec });
    const client: EmbeddingClient = { embed: embedSpy };

    const results = await embedFacetSummaries([SUMMARIES[0]!], { client });
    expect(results[0]!.status).toBe('error');
  });

  it('embedding with Infinity → isolated error', async () => {
    const vec = makeVector(1024);
    vec[0] = Infinity;
    const embedSpy = vi.fn().mockResolvedValue({ embedding: vec });
    const client: EmbeddingClient = { embed: embedSpy };

    const results = await embedFacetSummaries([SUMMARIES[0]!], { client });
    expect(results[0]!.status).toBe('error');
  });

  it('batch: invalid embedding for one item does not affect others', async () => {
    // First item → bad embedding; rest → good embeddings.
    const embedSpy = vi.fn<
      (opts: { input: string; model: string; dimension: number }) => Promise<EmbeddingResponse>
    >();
    embedSpy.mockResolvedValueOnce({ embedding: 'nope' as unknown as number[] });
    embedSpy.mockImplementation(async ({ dimension: d }) => ({
      embedding: makeVector(d),
    }));
    const client: EmbeddingClient = { embed: embedSpy };

    const results = await embedFacetSummaries(SUMMARIES, { client });
    expect(results[0]!.status).toBe('error');
    expect(results[1]!.status).toBe('ok');
    expect(results[2]!.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// 4. Model forwarding (Gateway swap)
// ---------------------------------------------------------------------------

describe('embedFacetSummaries — model forwarding', () => {
  it('forwards DEFAULT_EMBEDDING_MODEL and dimension 1024 to client.embed when no option given', async () => {
    const { client, embedSpy } = makeMockClient();
    await embedFacetSummaries([SUMMARIES[0]!], { client });

    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(embedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model: DEFAULT_EMBEDDING_MODEL,
        dimension: DEFAULT_EMBEDDING_DIMENSION,
      }),
    );
  });

  it('forwards a caller-supplied model string instead of the default', async () => {
    const { client, embedSpy } = makeMockClient();
    const customModel = 'text-embedding-3-large';
    await embedFacetSummaries([SUMMARIES[0]!], { client, model: customModel });

    expect(embedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: customModel }),
    );
  });

  it('forwards a caller-supplied dimension instead of the default', async () => {
    const { client: client256, embedSpy: spy256 } = makeMockClient();
    await embedFacetSummaries([SUMMARIES[0]!], { client: client256, dimension: 256 });

    expect(spy256).toHaveBeenCalledWith(
      expect.objectContaining({ dimension: 256 }),
    );
  });

  it('calls client.embed exactly once per summary', async () => {
    const { client, embedSpy } = makeMockClient();
    await embedFacetSummaries(SUMMARIES, { client });
    expect(embedSpy).toHaveBeenCalledTimes(SUMMARIES.length);
  });

  it('passes each summary text as the input field', async () => {
    const { client, embedSpy } = makeMockClient();
    await embedFacetSummaries([SUMMARIES[1]!], { client });

    expect(embedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ input: SUMMARIES[1]!.summary }),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Model version recorded with the vector (Acceptance Criterion #3)
// ---------------------------------------------------------------------------

describe('embedFacetSummaries — model version attribution', () => {
  it('ok result model field equals modelVersion when the client returns one', async () => {
    const resolvedVersion = 'gemini-embedding-001@2024-12';
    const { client } = makeMockClient(resolvedVersion);

    const results = await embedFacetSummaries([SUMMARIES[0]!], { client });
    const result = results[0]!;
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.model).toBe(resolvedVersion);
    }
  });

  it('ok result model field falls back to configured model string when modelVersion is absent', async () => {
    const { client } = makeMockClient();
    const customModel = 'my-custom-embed-model';

    const results = await embedFacetSummaries([SUMMARIES[0]!], {
      client,
      model: customModel,
    });
    const result = results[0]!;
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.model).toBe(customModel);
    }
  });

  it('full ok shape matches expected structure (toEqual pins multiple fields at once)', async () => {
    const resolvedVersion = 'gemini-embedding-001@2024-12';
    const vec = makeVector(1024);
    const embedSpy = vi.fn().mockResolvedValue({
      embedding: vec,
      modelVersion: resolvedVersion,
    });
    const client: EmbeddingClient = { embed: embedSpy };

    const results = await embedFacetSummaries([SUMMARIES[0]!], { client });
    expect(results[0]).toEqual({
      id: SUMMARIES[0]!.id,
      status: 'ok',
      embedding: vec,
      model: resolvedVersion,
      dimension: DEFAULT_EMBEDDING_DIMENSION,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Per-summary error isolation (Acceptance Criterion #4)
// ---------------------------------------------------------------------------

describe('embedFacetSummaries — per-item error isolation', () => {
  it('middle item rejection → that item is error, others are ok', async () => {
    const embedSpy = vi.fn<
      (opts: { input: string; model: string; dimension: number }) => Promise<EmbeddingResponse>
    >();
    embedSpy.mockImplementationOnce(async ({ dimension: d }) => ({
      embedding: makeVector(d),
    }));
    embedSpy.mockRejectedValueOnce(new Error('rate limit'));
    embedSpy.mockImplementationOnce(async ({ dimension: d }) => ({
      embedding: makeVector(d),
    }));

    const client: EmbeddingClient = { embed: embedSpy };
    const results = await embedFacetSummaries(SUMMARIES, { client });

    expect(results).toHaveLength(3);
    expect(results[0]!.status).toBe('ok');
    expect(results[1]!.status).toBe('error');
    expect(results[2]!.status).toBe('ok');

    const mid = results[1]!;
    if (mid.status === 'error') {
      expect(mid.error).toContain('rate limit');
    }
  });

  it('all items failing → N error results, embedFacetSummaries does not reject', async () => {
    const embedSpy = vi.fn().mockRejectedValue(new Error('model unavailable'));
    const client: EmbeddingClient = { embed: embedSpy };

    await expect(
      embedFacetSummaries(SUMMARIES, { client }),
    ).resolves.toHaveLength(SUMMARIES.length);

    const results = await embedFacetSummaries(SUMMARIES, { client });
    for (const r of results) {
      expect(r.status).toBe('error');
    }
  });

  it('non-Error rejection is stringified into the error field', async () => {
    const embedSpy = vi.fn().mockRejectedValue('plain string rejection');
    const client: EmbeddingClient = { embed: embedSpy };

    const results = await embedFacetSummaries([SUMMARIES[0]!], { client });
    const result = results[0]!;
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toContain('plain string rejection');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Empty input
// ---------------------------------------------------------------------------

describe('embedFacetSummaries — empty input', () => {
  it('resolves to [] for empty summaries array', async () => {
    const { client, embedSpy } = makeMockClient();
    const result = await embedFacetSummaries([], { client });
    expect(result).toEqual([]);
    expect(embedSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 8. Constants
// ---------------------------------------------------------------------------

describe('facet-embedder constants', () => {
  it('DEFAULT_EMBEDDING_DIMENSION is 1024', () => {
    expect(DEFAULT_EMBEDDING_DIMENSION).toBe(1024);
  });

  it('DEFAULT_EMBEDDING_MODEL is a non-empty string', () => {
    expect(typeof DEFAULT_EMBEDDING_MODEL).toBe('string');
    expect(DEFAULT_EMBEDDING_MODEL.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. EmbeddingSchemaError export (constructor accessible)
// ---------------------------------------------------------------------------

describe('EmbeddingSchemaError', () => {
  it('is an Error subclass with id and received fields', () => {
    const err = new EmbeddingSchemaError('my-id', 'bad shape', { bad: true });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('EmbeddingSchemaError');
    expect(err.id).toBe('my-id');
    expect(err.received).toEqual({ bad: true });
    expect(err.message).toBe('bad shape');
  });
});
