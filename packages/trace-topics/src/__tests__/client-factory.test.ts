import { describe, expect, test } from 'vitest';
import {
  createTopicsModelClientsFromEnv,
  resolveTopicsModelSelection,
} from '../client-factory';
import { GeminiRestClient } from '../gemini-rest-client';
import { OpenAICompatibleClient } from '../openai-compatible-client';
import { MockTopicsModelClient } from '../mock-topics-client';

describe('createTopicsModelClientsFromEnv — provider selection', () => {
  test('no provider + no key → THROWS (never a silent mock fallback)', () => {
    // Safety property: a missing/rotated key must fail loudly, not quietly
    // select the mock and persist fabricated insights. Default provider is
    // gemini, so the failure names the missing gemini key.
    expect(() => createTopicsModelClientsFromEnv({})).toThrow(/gemini needs GEMINI_API_KEY/i);
  });

  test('empty-string gemini key → THROWS (empty is not configured)', () => {
    expect(() => createTopicsModelClientsFromEnv({ GEMINI_API_KEY: '' })).toThrow(
      /gemini needs GEMINI_API_KEY/i,
    );
  });

  test('TOPICS_MOCK_MODEL=true → mock, one instance for both seams, no key needed', () => {
    const clients = createTopicsModelClientsFromEnv({ TOPICS_MOCK_MODEL: 'true' });
    expect(clients.mode).toBe('mock');
    expect(clients.structured).toBeInstanceOf(MockTopicsModelClient);
    expect(clients.embedding).toBe(clients.structured);
  });

  test('TOPICS_MOCK_MODEL=true forces mock even with a key present', () => {
    const clients = createTopicsModelClientsFromEnv({
      GEMINI_API_KEY: 'sk-live',
      TOPICS_MOCK_MODEL: 'true',
    });
    expect(clients.mode).toBe('mock');
    expect(clients.structured).toBeInstanceOf(MockTopicsModelClient);
  });

  test('GEMINI_API_KEY present (no provider) → gemini client + gemini model defaults', () => {
    const clients = createTopicsModelClientsFromEnv({ GEMINI_API_KEY: 'sk-live' });
    expect(clients.mode).toBe('gemini');
    expect(clients.structured).toBeInstanceOf(GeminiRestClient);
    expect(clients.embedding).toBe(clients.structured);
    expect(clients.models).toEqual({
      provider: 'gemini',
      facetModel: 'gemini-2.5-flash-lite',
      embeddingModel: 'gemini-embedding-001',
      namingModel: 'gemini-2.5-flash-lite',
      embeddingDimension: 1024,
    });
  });

  test('provider=openai + TOPICS_MODEL_API_KEY → OpenAI-compatible client + openai defaults', () => {
    const clients = createTopicsModelClientsFromEnv({
      TOPICS_MODEL_PROVIDER: 'openai',
      TOPICS_MODEL_API_KEY: 'sk-openai',
    });
    expect(clients.mode).toBe('openai');
    expect(clients.structured).toBeInstanceOf(OpenAICompatibleClient);
    expect(clients.embedding).toBe(clients.structured);
    expect(clients.models).toEqual({
      provider: 'openai',
      facetModel: 'gpt-5-nano',
      embeddingModel: 'text-embedding-3-small',
      namingModel: 'gpt-5-nano',
      embeddingDimension: 1024,
    });
  });

  test('provider=mistral + key → OpenAI-compatible client + mistral defaults', () => {
    const clients = createTopicsModelClientsFromEnv({
      TOPICS_MODEL_PROVIDER: 'mistral',
      TOPICS_MODEL_API_KEY: 'sk-mistral',
    });
    expect(clients.mode).toBe('mistral');
    expect(clients.structured).toBeInstanceOf(OpenAICompatibleClient);
    expect(clients.models).toEqual({
      provider: 'mistral',
      facetModel: 'mistral-small-latest',
      embeddingModel: 'mistral-embed',
      namingModel: 'mistral-small-latest',
      embeddingDimension: 1024,
    });
  });

  test('provider=openai WITHOUT a key → THROWS (never silent mock)', () => {
    expect(() =>
      createTopicsModelClientsFromEnv({ TOPICS_MODEL_PROVIDER: 'openai' }),
    ).toThrow(/openai needs TOPICS_MODEL_API_KEY/i);
  });

  test('unknown provider → THROWS with the allowed set', () => {
    expect(() =>
      createTopicsModelClientsFromEnv({
        TOPICS_MODEL_PROVIDER: 'anthropic',
        TOPICS_MODEL_API_KEY: 'sk',
      }),
    ).toThrow(/unknown TOPICS_MODEL_PROVIDER "anthropic".*gemini \| openai \| mistral/i);
  });

  test('a non-"true" mock value with a key stays on the real provider', () => {
    for (const value of ['false', '1', 'TRUE', 'yes']) {
      const clients = createTopicsModelClientsFromEnv({
        GEMINI_API_KEY: 'sk-live',
        TOPICS_MOCK_MODEL: value,
      });
      expect(clients.mode, `TOPICS_MOCK_MODEL="${value}"`).toBe('gemini');
    }
  });
});

describe('resolveTopicsModelSelection — model names + dimension', () => {
  test('per-facet env overrides win over provider defaults', () => {
    expect(
      resolveTopicsModelSelection({
        TOPICS_MODEL_PROVIDER: 'openai',
        TOPICS_FACET_MODEL: 'gpt-5-nano',
        TOPICS_EMBEDDING_MODEL: 'text-embedding-3-large',
        TOPICS_NAMING_MODEL: 'gpt-4o',
        TOPICS_EMBEDDING_DIMENSION: '1536',
      }),
    ).toEqual({
      provider: 'openai',
      facetModel: 'gpt-5-nano',
      embeddingModel: 'text-embedding-3-large',
      namingModel: 'gpt-4o',
      embeddingDimension: 1536,
    });
  });

  test('a non-positive dimension override falls back to the provider default', () => {
    expect(
      resolveTopicsModelSelection({
        TOPICS_MODEL_PROVIDER: 'openai',
        TOPICS_EMBEDDING_DIMENSION: 'nonsense',
      }).embeddingDimension,
    ).toBe(1024);
  });

  test('mock provider resolves selection without a key', () => {
    expect(resolveTopicsModelSelection({ TOPICS_MOCK_MODEL: 'true' }).provider).toBe('mock');
  });
});

describe('resolveTopicsChatCompletions', () => {
  test('null for gemini (default), mock, and missing key — text generation is optional', async () => {
    const { resolveTopicsChatCompletions } = await import('../client-factory.js');
    expect(resolveTopicsChatCompletions({})).toBeNull();
    expect(resolveTopicsChatCompletions({ TOPICS_MOCK_MODEL: 'true' })).toBeNull();
    expect(
      resolveTopicsChatCompletions({ TOPICS_MODEL_PROVIDER: 'openai' }),
    ).toBeNull();
  });

  test('openai and mistral resolve endpoint + naming-tier model + key; base URL overridable', async () => {
    const { resolveTopicsChatCompletions } = await import('../client-factory.js');
    expect(
      resolveTopicsChatCompletions({
        TOPICS_MODEL_PROVIDER: 'openai',
        TOPICS_MODEL_API_KEY: 'sk-x',
      }),
    ).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-5-nano',
    });
    expect(
      resolveTopicsChatCompletions({
        TOPICS_MODEL_PROVIDER: 'mistral',
        TOPICS_MODEL_API_KEY: 'sk-m',
        TOPICS_NAMING_MODEL: 'mistral-small-latest',
      }),
    ).toEqual(
      expect.objectContaining({ apiKey: 'sk-m', model: 'mistral-small-latest' }),
    );
    expect(
      resolveTopicsChatCompletions({
        TOPICS_MODEL_PROVIDER: 'openai',
        TOPICS_MODEL_API_KEY: 'sk-x',
        TOPICS_MODEL_BASE_URL: 'https://proxy.internal/v1',
      })!.baseUrl,
    ).toBe('https://proxy.internal/v1');
  });
});
