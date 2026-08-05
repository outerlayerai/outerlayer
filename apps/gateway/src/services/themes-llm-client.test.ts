import { describe, expect, test, vi } from "vitest";
import { createThemesLlmClient } from "./themes-llm-client";

const OPENAI_ENV = {
  TOPICS_MODEL_PROVIDER: "openai",
  TOPICS_MODEL_API_KEY: "sk-test-topics",
};

describe("createThemesLlmClient", () => {
  test("null for gemini/mock providers and for a missing key — themes are optional", () => {
    expect(createThemesLlmClient({})).toBeNull(); // default provider gemini
    expect(createThemesLlmClient({ TOPICS_MOCK_MODEL: "true" })).toBeNull();
    expect(createThemesLlmClient({ TOPICS_MODEL_PROVIDER: "openai" })).toBeNull();
  });

  test("openai: pins the chat-completions request — endpoint, auth, naming-tier model, messages, max_tokens", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '[{"label":"x"}]' } }] }),
    });
    const client = createThemesLlmClient(OPENAI_ENV, fetchImpl as unknown as typeof fetch)!;
    expect(client.model).toBe("gpt-5-nano");

    const text = await client.complete({ system: "sys", user: "usr", maxTokens: 1000 });
    expect(text).toBe('[{"label":"x"}]');
    expect(fetchImpl).toHaveBeenCalledWith("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-test-topics",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-5-nano",
        max_tokens: 1000,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "usr" },
        ],
      }),
    });
  });

  test("non-200 and empty content both throw (summarize degrades, never fabricates)", async () => {
    const bad = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await expect(
      createThemesLlmClient(OPENAI_ENV, bad as unknown as typeof fetch)!.complete({
        system: "s",
        user: "u",
        maxTokens: 10,
      }),
    ).rejects.toThrow("HTTP 429");

    const empty = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });
    await expect(
      createThemesLlmClient(OPENAI_ENV, empty as unknown as typeof fetch)!.complete({
        system: "s",
        user: "u",
        maxTokens: 10,
      }),
    ).rejects.toThrow("no content");
  });

  test("a custom base URL overrides the provider default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok-text" } }] }),
    });
    const client = createThemesLlmClient(
      { ...OPENAI_ENV, TOPICS_MODEL_BASE_URL: "https://proxy.internal/v1" },
      fetchImpl as unknown as typeof fetch,
    )!;
    await client.complete({ system: "s", user: "u", maxTokens: 5 });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://proxy.internal/v1/chat/completions");
  });
});
