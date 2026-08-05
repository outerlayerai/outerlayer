import { describe, expect, test, vi } from 'vitest';
import {
  BATCH_FACET_RESPONSE_SCHEMA,
  BATCH_FACET_SYSTEM_PROMPT,
  DEFAULT_BATCH_FACET_MODEL,
  summarizeFacetsBatched,
} from '../facet-batch-summarizer';
import type { StructuredModelClient } from '../structured-model-client';

const okResponse = {
  task: { summary: 'The agent booked a flight.' },
  sentiment: { label: 'POSITIVE', summary: 'The user thanked the agent.' },
  issues: { summary: 'No notable issues were found.' },
};

function clientReturning(value: unknown): StructuredModelClient & {
  generateObject: ReturnType<typeof vi.fn>;
} {
  return { generateObject: vi.fn().mockResolvedValue(value) };
}

describe('summarizeFacetsBatched', () => {
  test('one call returns all three facets with exact shapes', async () => {
    const client = clientReturning(okResponse);

    const result = await summarizeFacetsBatched('TRACE TEXT', { client });

    expect(result).toEqual({
      task: { facetKey: 'task', status: 'ok', summary: 'The agent booked a flight.' },
      sentiment: {
        facetKey: 'sentiment',
        status: 'ok',
        summary: 'The user thanked the agent.',
        label: 'POSITIVE',
      },
      issues: {
        facetKey: 'issues',
        status: 'ok',
        summary: 'No notable issues were found.',
      },
    });
    // Exactly ONE model call — the whole point of the batched design.
    expect(client.generateObject).toHaveBeenCalledTimes(1);
    expect(client.generateObject).toHaveBeenCalledWith({
      systemPrompt: BATCH_FACET_SYSTEM_PROMPT,
      userPrompt: 'TRACE TEXT',
      model: DEFAULT_BATCH_FACET_MODEL,
      responseSchema: BATCH_FACET_RESPONSE_SCHEMA,
    });
  });

  test('model override is forwarded verbatim', async () => {
    const client = clientReturning(okResponse);
    await summarizeFacetsBatched('t', { client, model: 'my-model' });
    expect(client.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'my-model' }),
    );
  });

  test('an invalid sentiment label degrades ONLY the sentiment facet (per-field isolation)', async () => {
    const client = clientReturning({
      ...okResponse,
      sentiment: { label: 'ECSTATIC', summary: 'so happy' },
    });

    const result = await summarizeFacetsBatched('t', { client });

    expect(result.task.status).toBe('ok');
    expect(result.issues.status).toBe('ok');
    expect(result.sentiment).toEqual({
      facetKey: 'sentiment',
      status: 'error',
      error: expect.stringContaining("Facet 'sentiment' missing or invalid"),
    });
  });

  test('a missing task field degrades ONLY the task facet', async () => {
    const { task: _task, ...withoutTask } = okResponse;
    const client = clientReturning(withoutTask);

    const result = await summarizeFacetsBatched('t', { client });

    expect(result.task).toEqual({
      facetKey: 'task',
      status: 'error',
      error: expect.stringContaining("Facet 'task' missing or invalid"),
    });
    expect(result.sentiment.status).toBe('ok');
    expect(result.issues.status).toBe('ok');
  });

  test('empty-string summaries are rejected, not passed through', async () => {
    const client = clientReturning({
      ...okResponse,
      issues: { summary: '' },
    });
    const result = await summarizeFacetsBatched('t', { client });
    expect(result.issues.status).toBe('error');
  });

  test('a client rejection fails all three facets with the same error and never throws', async () => {
    const client: StructuredModelClient = {
      generateObject: vi.fn().mockRejectedValue(new Error('429 rate limited')),
    };

    const result = await summarizeFacetsBatched('t', { client });

    expect(result).toEqual({
      task: { facetKey: 'task', status: 'error', error: '429 rate limited' },
      sentiment: { facetKey: 'sentiment', status: 'error', error: '429 rate limited' },
      issues: { facetKey: 'issues', status: 'error', error: '429 rate limited' },
    });
  });

  test('a non-object response fails all facets', async () => {
    const client = clientReturning('just a string');
    const result = await summarizeFacetsBatched('t', { client });
    expect(result.task.status).toBe('error');
    expect(result.sentiment.status).toBe('error');
    expect(result.issues.status).toBe('error');
  });
});
