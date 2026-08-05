// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { LlmClient } from "./types.js";

/** Cheap labeling work — Haiku is plenty for naming clusters. */
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Non-200 from the Anthropic API — status attached, body truncated to 200 chars. */
export class AnthropicHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Anthropic API error ${status}: ${body.slice(0, 200)}`);
    this.name = "AnthropicHttpError";
    this.status = status;
  }
}

export interface FetchAnthropicOptions {
  /** BYO key — never read from the environment here; the caller decides. */
  apiKey: string;
  model?: string;
  /** Injectable for tests — tests must never hit the network. */
  fetchImpl?: typeof fetch;
}

/**
 * The default fetch-based LlmClient — no SDK dependency. POSTs /v1/messages
 * with a system prompt + one user message and returns the first text block
 * of the response.
 */
export function fetchAnthropicClient(opts: FetchAnthropicOptions): LlmClient {
  const model = opts.model ?? DEFAULT_MODEL;
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    model,
    async complete(req) {
      const res = await doFetch(API_URL, {
        method: "POST",
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        }),
      });
      if (res.status !== 200) {
        throw new AnthropicHttpError(res.status, await res.text());
      }
      const data = (await res.json()) as { content?: { type?: string; text?: string }[] };
      const block = Array.isArray(data.content)
        ? data.content.find((b) => b && b.type === "text" && typeof b.text === "string")
        : undefined;
      if (!block || typeof block.text !== "string") {
        throw new Error("Anthropic response contained no text block");
      }
      return block.text;
    },
  };
}
