import { describe, expect, test } from 'vitest';
import { BATCH_FACET_RESPONSE_SCHEMA } from '../facet-batch-summarizer';
import {
  MOCK_EMBEDDING_MODEL_VERSION,
  MockTopicsModelClient,
  featureHashEmbedding,
} from '../mock-topics-client';
import { cosineSimilarity, l2Norm } from '../vector-math';

const client = new MockTopicsModelClient();

const NAMING_SCHEMA = { type: 'object', properties: { topics: {} } } as Record<
  string,
  unknown
>;

describe('MockTopicsModelClient — batched facets', () => {
  test('is deterministic: identical input → identical output', async () => {
    const req = {
      systemPrompt: 's',
      userPrompt: '[GENERATION] Input: refund for delayed shipment order 123',
      model: 'm',
      responseSchema: BATCH_FACET_RESPONSE_SCHEMA,
    };
    const a = await client.generateObject(req);
    const b = await client.generateObject(req);
    expect(a).toEqual(b);
  });

  test('negative markers drive NEGATIVE sentiment and an issues summary', async () => {
    const result = (await client.generateObject({
      systemPrompt: 's',
      userPrompt: 'Input: checkout failed with a timeout error for the customer',
      model: 'm',
      responseSchema: BATCH_FACET_RESPONSE_SCHEMA,
    })) as { sentiment: { label: string }; issues: { summary: string } };

    expect(result.sentiment.label).toBe('NEGATIVE');
    expect(result.issues.summary).toContain('problems');
  });

  test('clean traces yield NEUTRAL sentiment and an explicit no-issues summary', async () => {
    const result = (await client.generateObject({
      systemPrompt: 's',
      userPrompt: 'Input: what are the store opening hours downtown',
      model: 'm',
      responseSchema: BATCH_FACET_RESPONSE_SCHEMA,
    })) as { sentiment: { label: string }; issues: { summary: string } };

    expect(result.sentiment.label).toBe('NEUTRAL');
    expect(result.issues.summary).toBe('NONE');
  });

  test('unknown schema shape throws instead of guessing', async () => {
    await expect(
      client.generateObject({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'm',
        responseSchema: { type: 'object', properties: { other: {} } },
      }),
    ).rejects.toThrow('unrecognized responseSchema');
  });
});

describe('MockTopicsModelClient — naming', () => {
  test('names come from cluster keywords in the JSON payload', async () => {
    const result = await client.generateObject({
      systemPrompt: 's',
      userPrompt: JSON.stringify({
        clusters: [
          { topicId: 'v1-c0', keywords: ['refund', 'shipment', 'delayed'], exemplars: [] },
          { topicId: 'v1-c1', keywords: [], exemplars: [] },
        ],
      }),
      model: 'm',
      responseSchema: NAMING_SCHEMA,
    });

    expect(result).toEqual({
      topics: [
        {
          topicId: 'v1-c0',
          name: 'Refund Shipment Delayed',
          description: 'Sessions about refund, shipment, delayed.',
        },
        {
          topicId: 'v1-c1',
          name: 'Topic v1-c1',
          description: 'Sessions about a shared pattern.',
        },
      ],
    });
  });

  test('non-JSON naming payload throws', async () => {
    await expect(
      client.generateObject({
        systemPrompt: 's',
        userPrompt: 'not json',
        model: 'm',
        responseSchema: NAMING_SCHEMA,
      }),
    ).rejects.toThrow('was not JSON');
  });
});

describe('feature-hash embeddings', () => {
  test('embed returns a unit vector of the requested dimension with mock attribution', async () => {
    const result = await client.embed({
      input: 'The agent handled a request about refund shipment delayed.',
      model: 'ignored',
      dimension: 64,
    });
    expect(result.embedding).toHaveLength(64);
    expect(l2Norm(result.embedding)).toBeCloseTo(1, 10);
    expect(result.modelVersion).toBe(MOCK_EMBEDDING_MODEL_VERSION);
  });

  test('similarity structure is real: same-pattern texts are far closer than cross-pattern (the property clustering depends on)', () => {
    const dim = 256;
    const refundA = featureHashEmbedding(
      'The agent handled a request about refund delayed shipment order.',
      dim,
    );
    const refundB = featureHashEmbedding(
      'The agent handled a request about refund delayed shipment package.',
      dim,
    );
    const password = featureHashEmbedding(
      'The agent handled a request about password reset login account.',
      dim,
    );

    const same = cosineSimilarity(refundA, refundB);
    const cross = cosineSimilarity(refundA, password);
    expect(same).toBeGreaterThan(0.6);
    expect(cross).toBeLessThan(0.4);
    expect(same - cross).toBeGreaterThan(0.3);
  });

  test('is deterministic across calls', () => {
    expect(featureHashEmbedding('same text', 32)).toEqual(
      featureHashEmbedding('same text', 32),
    );
  });

  test('text with no salient tokens yields the zero vector', () => {
    expect(l2Norm(featureHashEmbedding('a an the', 16))).toBe(0);
  });
});

describe('MockTopicsModelClient — steering', () => {
  const steeringReq = (userPrompt: string) => ({
    systemPrompt: 's',
    userPrompt,
    model: 'm',
    responseSchema: {
      type: 'object',
      properties: { steering: {} },
    } as Record<string, unknown>,
  });

  test('no DEVELOPER line → exactly the empty-corrections shape', async () => {
    const result = await client.generateObject(
      steeringReq('### developer turn 2\nAGENT (context): something'),
    );
    expect(result).toEqual({ steering: { corrections: [] } });
  });

  test('one correction PER developer line, in order, quote = its first 60 chars', async () => {
    const first = 'Stop touching the billing module without approval.';
    const second =
      'Use @repo/api instead of the legacy client for every dashboard call you make from now on.';
    const result = (await client.generateObject(
      steeringReq(`DEVELOPER: ${first}\nAGENT (context): ok\nDEVELOPER: ${second}`),
    )) as { steering: { corrections: { summary: string }[] } };
    expect(result.steering.corrections).toHaveLength(2);
    const [a, b] = result.steering.corrections;
    // Each correction quotes ITS OWN turn, capped at exactly 60 chars.
    expect(a!.summary.endsWith(`— "${first.slice(0, 60)}"`)).toBe(true);
    expect(a!.summary).toContain('billing');
    expect(b!.summary.endsWith(`— "${second.slice(0, 60)}"`)).toBe(true);
    expect(b!.summary).toContain('legacy');
    expect(b!.summary).not.toContain('billing');
    expect(a!.summary.startsWith('Follow the team convention about ')).toBe(true);
  });

  test('stopword-only developer line falls back to the generic subject', async () => {
    const result = (await client.generateObject(
      steeringReq('DEVELOPER: that this the and are to it was'),
    )) as { steering: { corrections: { summary: string }[] } };
    expect(result.steering.corrections[0]!.summary).toContain('about the corrected approach —');
  });

  test('kinds derive deterministically from the wording — one branch each, positionally', async () => {
    const turns = [
      'Never push without running the tests first.', // rule wording
      'prefer the notion-like layout for markdown output.', // preference wording
      'Close the ticket and start on the dashboard item.', // neither → task_direction
      'Why is the gateway build so slow?   ', // trailing spaces — trim() then '?'
    ];
    const result = (await client.generateObject(
      steeringReq(turns.map((t) => `DEVELOPER: ${t}`).join('\n')),
    )) as { steering: { corrections: { kind: string }[] } };
    // Positional: rule wording must NOT read as preference (branch order),
    // plain imperatives must reach the task_direction fallback, and the
    // question check must trim before looking at the final character.
    expect(result.steering.corrections.map((c) => c.kind)).toEqual([
      'rule',
      'preference',
      'task_direction',
      'question',
    ]);
  });
});
