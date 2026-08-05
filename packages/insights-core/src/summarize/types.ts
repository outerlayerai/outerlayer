// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Severity } from "../types.js";

/**
 * The LLM summarization layer's types.
 *
 * Architecture rule: the LLM LABELS clusters the deterministic layer found —
 * it never invents findings. Clustering is deterministic code (cluster.ts);
 * the model only names/describes clusters, and it only ever sees rollups
 * (signatures + counts), never raw transcripts or session ids.
 */

/** One deterministic error rollup: every failed call sharing a `${tool}::${signature}` key. */
export interface ErrorCluster {
  /** Stable grouping key: `${tool}::${signature}`. */
  key: string;
  tool: string;
  /** The normalized error signature (as captured on the tool call). */
  signature: string;
  occurrences: number;
  /** Distinct sessions the error appeared in, in first-seen order. */
  sessionIds: string[];
  /** Distinct actors affected (0 locally, where actorId is null). */
  actorCount: number;
}

/** One LLM-labeled theme over clusters WE found. Evidence is always ours. */
export interface Theme {
  label: string;
  description: string;
  /** Keys of the input clusters this theme groups — validated, never invented. */
  clusterKeys: string[];
  /** Union of the referenced clusters' sessionIds — from OUR data, not the model's output. */
  evidenceSessionIds: string[];
  severity: Severity;
}

export interface SummarizeResult {
  themes: Theme[];
  /** True when the LLM half didn't deliver (no key, empty input, cost cap, call failure, bad output). */
  degraded: boolean;
  /** Pre-call spend estimate (0 when no prompt was even built). */
  estimatedCostUsd: number;
  /** Model label of the client that ran, when a call was made and the client declares one. */
  model: string | null;
}

/**
 * Injectable LLM client — the seam that keeps this package SDK-free and
 * tests off the network. The default is fetch-based (anthropic.ts); tests
 * inject a fake. Deliberately minimal: one text-in/text-out call.
 */
export interface LlmClient {
  /** Optional model label, recorded in SummarizeResult for audit. */
  readonly model?: string;
  complete(req: { system: string; user: string; maxTokens: number }): Promise<string>;
}
