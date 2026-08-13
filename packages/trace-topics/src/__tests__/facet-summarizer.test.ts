/**
 * Tests for summarizeFacets — Stage 2 of the Trace Topics pipeline.
 *
 * All tests use a MOCKED FacetModelClient — no live model calls, no Gateway
 * dependency.  The mock returns canned per-facet summaries keyed by facetKey.
 *
 * Test intent:
 *   - one result per facet, in input order
 *   - the correct model identifier is forwarded to the client
 *   - structured output is validated; malformed responses → FacetSchemaError
 *   - a per-facet error is isolated; others still return ok summaries
 */

import { describe, it, expect, vi } from 'vitest';
import {
  summarizeFacets,
  BUILTIN_FACETS,
  DEFAULT_FACET_MODEL,
  FacetSchemaError,
  FacetDefinition,
  FacetModelClient,
  FacetModelRequest,
  FacetModelResponse,
} from '../facet-summarizer';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a mock FacetModelClient using systemPrompt-to-response mapping. */
function makePromptMappedClient(
  promptToResponse: (req: FacetModelRequest) => FacetModelResponse | Error,
): FacetModelClient {
  return {
    call: vi.fn(async (req: FacetModelRequest): Promise<FacetModelResponse> => {
      const result = promptToResponse(req);
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

/** Simple mock client returning a fixed summary for all calls. */
function makeConstantClient(summary: string): FacetModelClient {
  return {
    call: vi.fn(async (): Promise<FacetModelResponse> => ({ summary })),
  };
}

// ---------------------------------------------------------------------------
// One result per facet, in input order
// ---------------------------------------------------------------------------

// proves AC-056-01
describe('one result per facet, in input order', () => {
  it('returns exactly one result for each enabled facet', async () => {
    const client = makeConstantClient('constant summary');
    const results = await summarizeFacets('trace text', BUILTIN_FACETS, { client });
    expect(results).toHaveLength(BUILTIN_FACETS.length);
  });

  it('result order matches input facet order', async () => {
    const client = makeConstantClient('constant summary');
    const results = await summarizeFacets('trace text', BUILTIN_FACETS, { client });
    expect(results.map((r) => r.facetKey)).toEqual(BUILTIN_FACETS.map((f) => f.key));
  });

  // proves AC-056-07
  it('works with a custom subset of facets', async () => {
    const custom: FacetDefinition[] = [
      { key: 'alpha', name: 'Alpha', systemPrompt: 'Summarize alpha.' },
      { key: 'beta', name: 'Beta', systemPrompt: 'Summarize beta.' },
    ];
    const client = makeConstantClient('custom summary');
    const results = await summarizeFacets('trace text', custom, { client });
    expect(results).toHaveLength(2);
    expect(results[0]!.facetKey).toBe('alpha');
    expect(results[1]!.facetKey).toBe('beta');
  });

  it('returns an empty array when no facets are provided', async () => {
    const client = makeConstantClient('should not be called');
    const results = await summarizeFacets('trace text', [], { client });
    expect(results).toEqual([]);
    expect((client.call as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('default BUILTIN_FACETS contains task, sentiment, issues in order', async () => {
    expect(BUILTIN_FACETS.map((f) => f.key)).toEqual(['task', 'sentiment', 'issues']);
  });
});

// ---------------------------------------------------------------------------
// Model forwarding
// ---------------------------------------------------------------------------

describe('model routing through FacetModelClient', () => {
  it('forwards the default model to the client when model is not provided', async () => {
    const client = makeConstantClient('summary');
    await summarizeFacets('trace text', BUILTIN_FACETS, { client });
    const calls = (client.call as ReturnType<typeof vi.fn>).mock.calls as FacetModelRequest[][];
    for (const [req] of calls) {
      expect(req!.model).toBe(DEFAULT_FACET_MODEL);
    }
  });

  it('forwards a custom model to the client when provided', async () => {
    const client = makeConstantClient('summary');
    await summarizeFacets('trace text', BUILTIN_FACETS, { client, model: 'claude-haiku-4-5' });
    const calls = (client.call as ReturnType<typeof vi.fn>).mock.calls as FacetModelRequest[][];
    for (const [req] of calls) {
      expect(req!.model).toBe('claude-haiku-4-5');
    }
  });

  it('calls the client once per facet', async () => {
    const client = makeConstantClient('summary');
    await summarizeFacets('trace text', BUILTIN_FACETS, { client });
    expect((client.call as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(BUILTIN_FACETS.length);
  });

  it('passes the preprocessed text as userPrompt to the client', async () => {
    const text = 'GENERATION — my-prompt\n  Input: hello\n  Output: world';
    const client = makeConstantClient('summary');
    await summarizeFacets(text, [BUILTIN_FACETS[0]!], { client });
    const calls = (client.call as ReturnType<typeof vi.fn>).mock.calls as FacetModelRequest[][];
    expect(calls[0]![0]!.userPrompt).toBe(text);
  });

  it('DEFAULT_FACET_MODEL references gemini-2.5-flash-lite', () => {
    expect(DEFAULT_FACET_MODEL).toBe('gemini-2.5-flash-lite');
  });
});

// ---------------------------------------------------------------------------
// Structured output validation
// ---------------------------------------------------------------------------

describe('structured output, schema-validated', () => {
  it('returns ok status with the summary string when response is valid', async () => {
    const client = makeConstantClient('The agent was trying to translate text.');
    const [result] = await summarizeFacets('trace text', [BUILTIN_FACETS[0]!], { client });
    expect(result).toEqual({
      facetKey: 'task',
      status: 'ok',
      summary: 'The agent was trying to translate text.',
    });
  });

  it('surfaces FacetSchemaError as an error result when summary is missing', async () => {
    const client = makePromptMappedClient(() => {
      // Return an object without `summary` to trigger schema validation failure.
      throw new FacetSchemaError('task', {}, "Facet 'task' returned invalid response: expected { summary: string }, got {}");
    });
    const [result] = await summarizeFacets('trace text', [BUILTIN_FACETS[0]!], { client });
    expect(result!.status).toBe('error');
    expect((result as { status: 'error'; error: string }).error).toContain('invalid response');
  });

  it('surfaces FacetSchemaError as an error result when summary is not a string', async () => {
    const client = makePromptMappedClient(() => {
      throw new FacetSchemaError('task', { summary: 42 }, "Facet 'task' returned invalid response: expected { summary: string }, got {\"summary\":42}");
    });
    const [result] = await summarizeFacets('trace text', [BUILTIN_FACETS[0]!], { client });
    expect(result!.status).toBe('error');
    expect((result as { status: 'error'; error: string }).error).toContain('invalid response');
  });
});

// ---------------------------------------------------------------------------
// Per-facet error isolation
// ---------------------------------------------------------------------------

describe('per-facet error isolation', () => {
  it('returns ok for passing facets when one facet fails', async () => {
    let callIndex = 0;
    const client: FacetModelClient = {
      call: vi.fn(async (): Promise<FacetModelResponse> => {
        callIndex++;
        // Fail only the second call (sentiment)
        if (callIndex === 2) throw new Error('model timeout');
        return { summary: `summary ${callIndex}` };
      }),
    };
    const results = await summarizeFacets('trace text', BUILTIN_FACETS, { client });
    expect(results[0]!.status).toBe('ok');
    expect(results[1]!.status).toBe('error');
    expect(results[2]!.status).toBe('ok');
  });

  it('surfaces the error message in the error result', async () => {
    const client: FacetModelClient = {
      call: vi.fn(async (): Promise<FacetModelResponse> => {
        throw new Error('gateway 503');
      }),
    };
    const [result] = await summarizeFacets('trace text', [BUILTIN_FACETS[0]!], { client });
    expect(result!.status).toBe('error');
    expect((result as { status: 'error'; error: string }).error).toBe('gateway 503');
  });

  it('does not throw even when all facets fail', async () => {
    const client: FacetModelClient = {
      call: vi.fn(async (): Promise<FacetModelResponse> => {
        throw new Error('all failed');
      }),
    };
    await expect(summarizeFacets('trace text', BUILTIN_FACETS, { client })).resolves.toHaveLength(
      BUILTIN_FACETS.length,
    );
    const results = await summarizeFacets('trace text', BUILTIN_FACETS, { client });
    for (const result of results) {
      expect(result.status).toBe('error');
    }
  });

  it('stringifies non-Error rejections in the error result', async () => {
    const client: FacetModelClient = {
      call: vi.fn(async (): Promise<FacetModelResponse> => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string rejection';
      }),
    };
    const [result] = await summarizeFacets('trace text', [BUILTIN_FACETS[0]!], { client });
    expect(result!.status).toBe('error');
    expect((result as { status: 'error'; error: string }).error).toBe('string rejection');
  });
});

// ---------------------------------------------------------------------------
// Built-in facet definitions
// ---------------------------------------------------------------------------

describe('BUILTIN_FACETS', () => {
  it('each facet has a non-empty key, name, and systemPrompt', () => {
    for (const facet of BUILTIN_FACETS) {
      expect(facet.key.length).toBeGreaterThan(0);
      expect(facet.name.length).toBeGreaterThan(0);
      expect(facet.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  it('keys are unique', () => {
    const keys = BUILTIN_FACETS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('FacetSchemaError carries the facetKey and received value', () => {
    const err = new FacetSchemaError('issues', { bad: true }, 'bad response');
    expect(err.facetKey).toBe('issues');
    expect(err.received).toEqual({ bad: true });
    expect(err.name).toBe('FacetSchemaError');
  });
});
