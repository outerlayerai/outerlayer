/**
 * Theme-labeling LLM client for the findings compute — the SAME provider and
 * key the topics stack uses (TOPICS_MODEL_PROVIDER / TOPICS_MODEL_API_KEY),
 * adapted to insights-core's minimal LlmClient seam. One model stack for the
 * whole insight layer; no second vendor key.
 *
 * insights-core is a published Apache package and stays self-contained (its
 * default is a BYO Anthropic client) — it cannot depend on workspace-internal
 * packages like @repo/trace-topics, so the adapter lives here in the gateway
 * and is injected by the findings handler. Null — themes simply skip — when
 * the configured provider has no OpenAI-compatible chat endpoint or no key
 * is set.
 */

import { resolveTopicsChatCompletions, type TopicsModelEnv } from "@repo/trace-topics";
import type { LlmClient } from "@outerlayer/insights-core";

export function createThemesLlmClient(
  env: TopicsModelEnv,
  fetchImpl: typeof fetch = fetch,
): LlmClient | null {
  const chat = resolveTopicsChatCompletions(env);
  if (!chat) return null;

  return {
    model: chat.model,
    async complete(req: { system: string; user: string; maxTokens: number }): Promise<string> {
      const response = await fetchImpl(`${chat.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${chat.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: chat.model,
          max_tokens: req.maxTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`themes chat completion failed: HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("themes chat completion returned no content");
      }
      return content;
    },
  };
}
