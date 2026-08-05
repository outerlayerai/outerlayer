// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import type { Severity } from "../types.js";
import type { ErrorCluster, LlmClient, SummarizeResult, Theme } from "./types.js";

/** Pre-call estimate rates — claude-haiku-4-5 list price: $1/M input, $5/M output. */
const USD_PER_INPUT_TOKEN = 1 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 5 / 1_000_000;
/** Output allowance for the labeling call; doubles as the estimate's output term. */
const MAX_OUTPUT_TOKENS = 1000;
/** Rough chars/token — good enough for a spend cap, no tokenizer dependency. */
const CHARS_PER_TOKEN = 4;

export interface SummarizeOptions {
  /** Null = no API key configured → graceful degraded result, never a throw. */
  client: LlmClient | null;
  /** Max themes kept from the model's output (default 5). */
  maxThemes?: number;
  /** Skip the call when the pre-call estimate exceeds this (default $0.50). */
  costCapUsd?: number;
  /** Compile-time guard: there is no clock here. Aside from the one LLM call,
   * summarization is deterministic — do not add time-dependent inputs. */
  now?: never;
}

/**
 * The LLM half of summarization: ask a model to LABEL the clusters the deterministic
 * layer found. The model groups and names; it cannot add findings — themes
 * referencing keys we never produced are dropped, and evidence session ids
 * always come from our clusters, never from the model's output.
 *
 * Degrades (empty themes, `degraded: true`) instead of throwing on every
 * failure mode: no client, nothing to label, cost cap exceeded, call failure,
 * unusable output. The deterministic findings are the product; this layer is
 * garnish.
 */
export async function summarizeClusters(clusters: ErrorCluster[], opts: SummarizeOptions): Promise<SummarizeResult> {
  const { client, maxThemes = 5, costCapUsd = 0.5 } = opts;
  if (client === null || clusters.length === 0) {
    return { themes: [], degraded: true, estimatedCostUsd: 0, model: null };
  }
  const system = buildSystem(maxThemes);
  // Rollups only — key/tool/signature/occurrences/actorCount. No session ids,
  // no transcript content, ever.
  const user = JSON.stringify(
    clusters.map((c) => ({ key: c.key, tool: c.tool, signature: c.signature, occurrences: c.occurrences, actorCount: c.actorCount })),
  );
  // Estimate BEFORE calling: prompt chars ÷ 4 as input tokens + the full
  // output allowance, priced at the haiku-ish rates above.
  const estimatedCostUsd =
    ((system.length + user.length) / CHARS_PER_TOKEN) * USD_PER_INPUT_TOKEN + MAX_OUTPUT_TOKENS * USD_PER_OUTPUT_TOKEN;
  if (estimatedCostUsd > costCapUsd) {
    return { themes: [], degraded: true, estimatedCostUsd, model: null };
  }
  const model = client.model ?? null;
  let raw: string;
  try {
    raw = await client.complete({ system, user, maxTokens: MAX_OUTPUT_TOKENS });
  } catch {
    return { themes: [], degraded: true, estimatedCostUsd, model };
  }
  const themes = parseThemes(raw, clusters, maxThemes);
  if (themes === null) {
    return { themes: [], degraded: true, estimatedCostUsd, model };
  }
  return { themes, degraded: false, estimatedCostUsd, model };
}

function buildSystem(maxThemes: number): string {
  return [
    "You label recurring coding-agent failure clusters that deterministic analysis already found.",
    "Your job is ONLY to name and describe groups of the provided clusters — never invent new findings.",
    `Return at most ${maxThemes} themes as JSON only (no prose, no markdown):`,
    '[{"label": string, "description": string, "clusterKeys": string[], "severity": "info"|"warn"|"high"}]',
    'Every entry in "clusterKeys" must be a key copied exactly from the input; inventing keys is forbidden.',
  ].join("\n");
}

/** The model may wrap its JSON in ```json fences — unwrap before parsing. */
function stripFences(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  return (fenced ? fenced[1]! : raw).trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Null = unusable output (not JSON, or no theme list). Individually bad
 * themes are dropped, not fatal: missing label/description, empty keys, any
 * key we never produced (the anti-invention gate), beyond maxThemes. Invalid
 * severity degrades to "info".
 */
function parseThemes(raw: string, clusters: ErrorCluster[], maxThemes: number): Theme[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.themes) ? parsed.themes : null;
  if (list === null) return null;
  const byKey = new Map<string, ErrorCluster>(clusters.map((c) => [c.key, c]));
  const themes: Theme[] = [];
  for (const item of list) {
    if (themes.length >= maxThemes) break;
    if (!isRecord(item) || typeof item.label !== "string" || typeof item.description !== "string") continue;
    if (!Array.isArray(item.clusterKeys) || item.clusterKeys.length === 0) continue;
    if (!item.clusterKeys.every((k) => typeof k === "string" && byKey.has(k))) continue;
    const clusterKeys: string[] = [...new Set<string>(item.clusterKeys)];
    // Evidence is OUR data: the union of the referenced clusters' session ids,
    // in cluster order, first occurrence wins.
    const seen = new Set<string>();
    const evidenceSessionIds: string[] = [];
    for (const key of clusterKeys) {
      for (const sid of byKey.get(key)!.sessionIds) {
        if (!seen.has(sid)) {
          seen.add(sid);
          evidenceSessionIds.push(sid);
        }
      }
    }
    const severity: Severity =
      item.severity === "info" || item.severity === "warn" || item.severity === "high" ? item.severity : "info";
    themes.push({ label: item.label, description: item.description, clusterKeys, evidenceSessionIds, severity });
  }
  return themes;
}
