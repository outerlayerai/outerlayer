/**
 * Sync script for the model registry.
 * Fetches model metadata from LiteLLM (primary) and OpenRouter (secondary),
 * merges into a unified models.json, and generates a changelog.
 *
 * OpenRouter also provides per-model supportedParameters (which editor
 * params each model accepts), extracted during fetch and copied onto
 * LiteLLM-primary entries during merge.
 *
 * Usage: npx tsx scripts/sync-model-registry.ts
 */

import * as fs from "fs";
import * as path from "path";
import type {
  ModelEntry,
  ModelMode,
  ModelCapabilities,
  ModelsFile,
  SyncChangelog,
} from "../packages/model-registry/src/types";
import {
  modelsFileSchema,
  overridesFileSchema,
} from "../packages/model-registry/src/validation";

// ─── Constants ──────────────────────────────────────────────────

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

const OUTPUT_PATH = path.resolve(
  __dirname,
  "../packages/model-registry/models.json"
);

const OVERRIDES_PATH = path.resolve(
  __dirname,
  "../packages/model-registry/overrides.json"
);

const RELEVANT_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "vertex_ai",
  "google",
  "xai",
  "groq",
  "cohere",
  "mistral",
  "deepseek",
  "together_ai",
  "fireworks_ai",
  "bedrock",
  "azure",
  "perplexity",
]);

const PROVIDER_NORMALIZATION: Record<string, string> = {
  vertex_ai: "google",
  "vertex_ai-language-models": "google",
  "vertex_ai-anthropic_models": "google",
  vertex_ai_beta: "google",
  "azure/": "azure",
  "azure_ai/": "azure",
  azure_ai: "azure",
  bedrock_converse: "bedrock",
  gemini: "google",
};

// ─── LiteLLM Types ─────────────────────────────────────────────

interface LiteLLMEntry {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  mode?: string;
  supports_vision?: boolean;
  supports_function_calling?: boolean;
  supports_parallel_function_calling?: boolean;
  supports_response_schema?: boolean;
  supports_prompt_caching?: boolean;
  supports_reasoning?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  supports_pdf_input?: boolean;
  supports_web_search?: boolean;
  deprecation_date?: string;
}

// ─── OpenRouter Types ───────────────────────────────────────────

interface OpenRouterModel {
  id: string;
  name?: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  top_provider?: {
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  supported_parameters?: string[];
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

// ─── Display Name Generation ────────────────────────────────────

const DISPLAY_NAME_MAP: Record<string, string> = {
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4": "GPT-4",
  "gpt-4-turbo": "GPT-4 Turbo",
  "gpt-3.5-turbo": "GPT-3.5 Turbo",
  "gpt-5": "GPT-5",
  "o1": "o1",
  "o1-mini": "o1 Mini",
  "o1-preview": "o1 Preview",
  "o3": "o3",
  "o3-mini": "o3 Mini",
  "dall-e-3": "DALL-E 3",
  "dall-e-2": "DALL-E 2",
  "tts-1": "TTS-1",
  "tts-1-hd": "TTS-1 HD",
  "whisper-1": "Whisper",
};

export function generateDisplayName(modelId: string): string {
  if (DISPLAY_NAME_MAP[modelId]) {
    return DISPLAY_NAME_MAP[modelId]!;
  }

  // claude-3-opus-20240229 → Claude 3 Opus
  // claude-3-5-sonnet-20241022 → Claude 3.5 Sonnet
  const claudeMatch = modelId.match(
    /^claude-(\d+(?:-\d+)?)-(\w+?)(?:-\d{8})?$/
  );
  if (claudeMatch) {
    const version = claudeMatch[1]!.replace("-", ".");
    const variant =
      claudeMatch[2]!.charAt(0).toUpperCase() + claudeMatch[2]!.slice(1);
    return `Claude ${version} ${variant}`;
  }

  // gemini-2.0-flash → Gemini 2.0 Flash
  const geminiMatch = modelId.match(
    /^gemini-(\d+\.\d+)-(\w+?)(?:-(?:preview|latest|exp).*)?$/
  );
  if (geminiMatch) {
    const variant =
      geminiMatch[2]!.charAt(0).toUpperCase() + geminiMatch[2]!.slice(1);
    return `Gemini ${geminiMatch[1]} ${variant}`;
  }

  // grok-3 → Grok 3
  const grokMatch = modelId.match(/^grok-(\d+)(?:-(\w+))?(?:-(\w+))?$/);
  if (grokMatch) {
    let name = `Grok ${grokMatch[1]}`;
    if (grokMatch[2]) {
      name += ` ${grokMatch[2].charAt(0).toUpperCase() + grokMatch[2].slice(1)}`;
    }
    if (grokMatch[3]) {
      name += ` ${grokMatch[3].charAt(0).toUpperCase() + grokMatch[3].slice(1)}`;
    }
    return name;
  }

  // Generic: hyphen-separated → Title Case, strip date suffixes
  const cleaned = modelId.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return cleaned
    .split(/[-_]/)
    .map((part) => {
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

// ─── Provider Normalization ─────────────────────────────────────

function normalizeProvider(provider: string): string {
  for (const [prefix, normalized] of Object.entries(PROVIDER_NORMALIZATION)) {
    if (provider === prefix || provider.startsWith(prefix)) {
      return normalized;
    }
  }
  return provider;
}

// ─── Mode Mapping ───────────────────────────────────────────────

function mapLiteLLMMode(mode?: string): ModelMode {
  switch (mode) {
    case "chat":
    case "completion":
      return "chat";
    case "embedding":
      return "embedding";
    case "image_generation":
      return "image_generation";
    case "audio_speech":
      return "audio_speech";
    case "audio_transcription":
      return "audio_transcription";
    case "moderation":
      return "moderation";
    case "rerank":
      return "rerank";
    default:
      return "chat";
  }
}

// ─── Editor-relevant parameters ─────────────────────────────────

const EDITOR_PARAMS = new Set([
  "temperature", "max_tokens", "top_p", "top_k",
  "frequency_penalty", "presence_penalty",
]);

// ─── Fetchers ───────────────────────────────────────────────────

export interface FetchFn {
  (url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

export async function fetchLiteLLM(
  fetchFn: FetchFn = fetch
): Promise<Map<string, Omit<ModelEntry, "id">>> {
  console.log("Fetching LiteLLM model data...");
  const res = await fetchFn(LITELLM_URL);
  if (!res.ok) {
    throw new Error(`LiteLLM fetch failed`);
  }

  const data = (await res.json()) as Record<string, LiteLLMEntry>;
  const models = new Map<string, Omit<ModelEntry, "id">>();

  for (const [key, entry] of Object.entries(data)) {
    // Skip sample/meta entries
    if (key.startsWith("sample_spec") || !entry.litellm_provider) {
      continue;
    }

    const rawProvider = entry.litellm_provider;
    const normalizedProvider = normalizeProvider(rawProvider);

    // Filter to relevant providers
    if (!RELEVANT_PROVIDERS.has(rawProvider) && !RELEVANT_PROVIDERS.has(normalizedProvider)) {
      continue;
    }

    // Strip provider prefix from model ID (e.g., "openai/gpt-4o" → "gpt-4o")
    let modelId = key;
    const prefixes = [
      `${rawProvider}/`,
      `${normalizedProvider}/`,
    ];
    for (const prefix of prefixes) {
      if (modelId.startsWith(prefix)) {
        modelId = modelId.slice(prefix.length);
        break;
      }
    }

    // Build capabilities
    const capabilities: ModelCapabilities = {};
    if (entry.supports_vision !== undefined)
      capabilities.vision = entry.supports_vision;
    if (entry.supports_function_calling !== undefined)
      capabilities.functionCalling = entry.supports_function_calling;
    if (entry.supports_parallel_function_calling !== undefined)
      capabilities.parallelFunctionCalling =
        entry.supports_parallel_function_calling;
    if (entry.supports_response_schema !== undefined)
      capabilities.structuredOutput = entry.supports_response_schema;
    if (entry.supports_prompt_caching !== undefined)
      capabilities.promptCaching = entry.supports_prompt_caching;
    if (entry.supports_reasoning !== undefined)
      capabilities.reasoning = entry.supports_reasoning;
    if (entry.supports_audio_input !== undefined)
      capabilities.audioInput = entry.supports_audio_input;
    if (entry.supports_audio_output !== undefined)
      capabilities.audioOutput = entry.supports_audio_output;
    if (entry.supports_pdf_input !== undefined)
      capabilities.pdfInput = entry.supports_pdf_input;
    if (entry.supports_web_search !== undefined)
      capabilities.webSearch = entry.supports_web_search;

    const modelEntry: Omit<ModelEntry, "id"> = {
      provider: normalizedProvider,
      displayName: generateDisplayName(modelId),
      mode: mapLiteLLMMode(entry.mode),
      source: "litellm",
    };

    // Pricing
    if (
      entry.input_cost_per_token !== undefined &&
      entry.output_cost_per_token !== undefined
    ) {
      modelEntry.pricing = {
        inputCostPerToken: entry.input_cost_per_token,
        outputCostPerToken: entry.output_cost_per_token,
      };
      if (entry.cache_creation_input_token_cost !== undefined) {
        modelEntry.pricing.cacheCreationCostPerToken =
          entry.cache_creation_input_token_cost;
      }
      if (entry.cache_read_input_token_cost !== undefined) {
        modelEntry.pricing.cacheReadCostPerToken =
          entry.cache_read_input_token_cost;
      }
    }

    // Context — sanitize: skip zero/negative values, cap maxOutput to maxInput
    const maxInput = entry.max_input_tokens ?? entry.max_tokens;
    const maxOutput = entry.max_output_tokens;
    if (maxInput !== undefined || maxOutput !== undefined) {
      modelEntry.context = {};
      if (maxInput !== undefined && maxInput > 0) {
        modelEntry.context.maxInputTokens = maxInput;
      }
      if (maxOutput !== undefined && maxOutput > 0) {
        // Cap maxOutputTokens to maxInputTokens when both present
        if (modelEntry.context.maxInputTokens !== undefined && maxOutput > modelEntry.context.maxInputTokens) {
          modelEntry.context.maxOutputTokens = modelEntry.context.maxInputTokens;
        } else {
          modelEntry.context.maxOutputTokens = maxOutput;
        }
      }
      // Remove empty context
      if (Object.keys(modelEntry.context).length === 0) {
        delete modelEntry.context;
      }
    }

    // Capabilities
    if (Object.keys(capabilities).length > 0) {
      modelEntry.capabilities = capabilities;
    }

    // Deprecation
    if (entry.deprecation_date) {
      modelEntry.deprecationDate = entry.deprecation_date;
    }

    // Add model, preferring canonical entries (where key === modelId, no prefix stripped)
    // Azure/Bedrock entries come from "azure/gpt-4o" while the canonical "gpt-4o" is OpenAI
    const isCanonical = key === modelId;
    const existing = models.get(modelId);
    if (!existing) {
      models.set(modelId, modelEntry);
    } else if (isCanonical) {
      // Bare key (no prefix) is the canonical entry — always prefer it
      models.set(modelId, modelEntry);
    }
  }

  console.log(`  LiteLLM: ${models.size} models extracted`);
  return models;
}

export async function fetchOpenRouter(
  fetchFn: FetchFn = fetch
): Promise<Map<string, Omit<ModelEntry, "id">>> {
  console.log("Fetching OpenRouter model data...");
  const res = await fetchFn(OPENROUTER_URL);
  if (!res.ok) {
    throw new Error(`OpenRouter fetch failed`);
  }

  const data = (await res.json()) as OpenRouterResponse;
  const models = new Map<string, Omit<ModelEntry, "id">>();

  for (const model of data.data) {
    // Strip provider prefix (e.g., "openai/gpt-4o" → "gpt-4o")
    const parts = model.id.split("/");
    const providerRaw = parts.length > 1 ? parts[0]! : "unknown";
    const modelId = parts.length > 1 ? parts.slice(1).join("/") : model.id;

    const normalizedProvider = normalizeProvider(providerRaw);

    // Filter to relevant providers
    if (
      !RELEVANT_PROVIDERS.has(providerRaw) &&
      !RELEVANT_PROVIDERS.has(normalizedProvider)
    ) {
      continue;
    }

    // Build capabilities from modalities
    const capabilities: ModelCapabilities = {};
    const inputMods = model.architecture?.input_modalities ?? [];
    const outputMods = model.architecture?.output_modalities ?? [];
    const supportedParams = model.supported_parameters ?? [];

    if (inputMods.includes("image")) capabilities.vision = true;
    if (inputMods.includes("audio")) capabilities.audioInput = true;
    if (outputMods.includes("audio")) capabilities.audioOutput = true;
    if (supportedParams.includes("tools")) capabilities.functionCalling = true;
    if (supportedParams.includes("response_format"))
      capabilities.structuredOutput = true;

    // Filter to editor-relevant parameters
    const editorParams = supportedParams.filter((p) => EDITOR_PARAMS.has(p));

    const entry: Omit<ModelEntry, "id"> = {
      provider: normalizedProvider,
      displayName: model.name ?? generateDisplayName(modelId),
      mode: "chat",
      source: "openrouter",
    };

    if (editorParams.length > 0) {
      entry.supportedParameters = editorParams;
    }

    // Pricing
    if (model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined) {
      const inputCost = parseFloat(model.pricing.prompt);
      const outputCost = parseFloat(model.pricing.completion);
      if (!isNaN(inputCost) && !isNaN(outputCost)) {
        entry.pricing = {
          inputCostPerToken: inputCost,
          outputCostPerToken: outputCost,
        };
      }
    }

    // Context
    if (model.context_length) {
      entry.context = {
        maxInputTokens: model.context_length,
      };
      if (model.top_provider?.max_completion_tokens) {
        entry.context.maxOutputTokens =
          model.top_provider.max_completion_tokens;
      }
    }

    // Capabilities
    if (Object.keys(capabilities).length > 0) {
      entry.capabilities = capabilities;
    }

    if (!models.has(modelId)) {
      models.set(modelId, entry);
    }
  }

  console.log(`  OpenRouter: ${models.size} models extracted`);
  return models;
}

// ─── Merge Logic ────────────────────────────────────────────────

export function mergeModels(
  litellmModels: Map<string, Omit<ModelEntry, "id">>,
  openrouterModels: Map<string, Omit<ModelEntry, "id">>
): Map<string, Omit<ModelEntry, "id">> {
  const merged = new Map<string, Omit<ModelEntry, "id">>();

  // Start with all LiteLLM models (primary source)
  for (const [id, entry] of litellmModels) {
    merged.set(id, { ...entry });
  }

  // Add OpenRouter models that aren't in LiteLLM, or fill gaps
  for (const [id, orEntry] of openrouterModels) {
    const existing = merged.get(id);
    if (!existing) {
      // Model only in OpenRouter — add it
      merged.set(id, { ...orEntry });
    } else {
      // Model in both — OpenRouter fills undefined fields only
      if (!existing.pricing && orEntry.pricing) {
        existing.pricing = orEntry.pricing;
      }
      if (!existing.context && orEntry.context) {
        existing.context = orEntry.context;
      } else if (existing.context && orEntry.context) {
        if (
          existing.context.maxOutputTokens === undefined &&
          orEntry.context.maxOutputTokens !== undefined
        ) {
          existing.context.maxOutputTokens = orEntry.context.maxOutputTokens;
        }
      }

      // Supplement capabilities (don't override)
      if (orEntry.capabilities) {
        if (!existing.capabilities) {
          existing.capabilities = { ...orEntry.capabilities };
        } else {
          for (const [key, value] of Object.entries(orEntry.capabilities)) {
            const capKey = key as keyof ModelCapabilities;
            if (existing.capabilities[capKey] === undefined && value !== undefined) {
              (existing.capabilities as Record<string, boolean | undefined>)[
                capKey
              ] = value;
            }
          }
        }
      }

      // Copy supportedParameters from OpenRouter (LiteLLM never has them)
      if (orEntry.supportedParameters && !existing.supportedParameters) {
        existing.supportedParameters = orEntry.supportedParameters;
      }

      // Use OpenRouter display name if LiteLLM one looks auto-generated
      if (
        orEntry.displayName &&
        existing.displayName === generateDisplayName(id)
      ) {
        existing.displayName = orEntry.displayName;
      }
    }
  }

  console.log(`  Merged: ${merged.size} total models`);
  return merged;
}

// ─── Post-Merge Sanitization ────────────────────────────────────

export function sanitizeModels(
  models: Map<string, Omit<ModelEntry, "id">>
): void {
  for (const [_id, entry] of models) {
    if (entry.context) {
      // Remove zero/negative values
      if (entry.context.maxInputTokens !== undefined && entry.context.maxInputTokens <= 0) {
        delete entry.context.maxInputTokens;
      }
      if (entry.context.maxOutputTokens !== undefined && entry.context.maxOutputTokens <= 0) {
        delete entry.context.maxOutputTokens;
      }
      // Cap maxOutputTokens to maxInputTokens
      if (
        entry.context.maxInputTokens !== undefined &&
        entry.context.maxOutputTokens !== undefined &&
        entry.context.maxOutputTokens > entry.context.maxInputTokens
      ) {
        entry.context.maxOutputTokens = entry.context.maxInputTokens;
      }
      // Remove empty context
      if (Object.keys(entry.context).length === 0) {
        delete entry.context;
      }
    }
  }
}

// ─── Deprecation Handling ───────────────────────────────────────

export interface DeprecationDelta {
  /** Models whose deprecationDate was newly set this run. */
  newlyDeprecated: string[];
  /** Models whose deprecationDate was cleared this run (reappeared upstream). */
  resurrected: string[];
}

/**
 * Mark models missing from upstream as deprecated and rebuild the Map so
 * existing entries keep their position from the previous models.json. New
 * upstream additions are appended at the end. This produces minimal diffs:
 * a deprecation shows as a one-field addition rather than a moved block.
 */
export function handleDeprecation(
  newModels: Map<string, Omit<ModelEntry, "id">>,
  existingModels: Record<string, Omit<ModelEntry, "id">>
): DeprecationDelta {
  const today = new Date().toISOString().split("T")[0]!;
  const delta: DeprecationDelta = { newlyDeprecated: [], resurrected: [] };

  const reordered = new Map<string, Omit<ModelEntry, "id">>();

  // Pass 1: walk existing models in their original order. For each one,
  // either carry forward the upstream entry (clearing deprecation if it
  // came back) or rescue the existing entry with a fresh deprecation stamp.
  for (const [id, existing] of Object.entries(existingModels)) {
    const upstream = newModels.get(id);
    if (upstream) {
      if (existing.deprecationDate && !upstream.deprecationDate) {
        upstream.deprecationDate = null;
        delta.resurrected.push(id);
      }
      reordered.set(id, upstream);
    } else {
      const rescued = { ...existing };
      if (!rescued.deprecationDate) {
        rescued.deprecationDate = today;
        delta.newlyDeprecated.push(id);
      }
      reordered.set(id, rescued);
    }
  }

  // Pass 2: append truly-new models (in newModels but not in existingModels)
  // at the end, preserving merge order.
  for (const [id, entry] of newModels) {
    if (!reordered.has(id)) {
      reordered.set(id, entry);
    }
  }

  // Mutate `newModels` in place so callers continue to use the same Map.
  newModels.clear();
  for (const [id, entry] of reordered) {
    newModels.set(id, entry);
  }

  return delta;
}

// ─── Changelog Generation ───────────────────────────────────────

export function generateChangelog(
  newModels: Map<string, Omit<ModelEntry, "id">>,
  existingModels: Record<string, Omit<ModelEntry, "id">>,
  deprecationDelta: DeprecationDelta = { newlyDeprecated: [], resurrected: [] }
): SyncChangelog {
  const changelog: SyncChangelog = {
    added: [],
    removed: [],
    deprecated: [...deprecationDelta.newlyDeprecated],
    resurrected: [...deprecationDelta.resurrected],
    pricingChanged: [],
    capabilitiesChanged: [],
    anomalies: [],
  };

  const existingIds = new Set(Object.keys(existingModels));
  const newIds = new Set(newModels.keys());

  // Added models (in newModels, not previously known). handleDeprecation
  // rescues missing-upstream models back into newModels, so "removed" is
  // surfaced via `deprecated` instead.
  for (const id of newIds) {
    if (!existingIds.has(id)) {
      changelog.added.push(id);
    }
  }

  // `removed` is retained for backward compatibility but is no longer
  // populated — every existing model is either carried forward or moved
  // into `deprecated`.

  // Pricing and capability changes for existing models
  for (const id of existingIds) {
    const oldEntry = existingModels[id]!;
    const newEntry = newModels.get(id);
    if (!newEntry) continue;

    // Pricing changes
    if (oldEntry.pricing && newEntry.pricing) {
      for (const field of [
        "inputCostPerToken",
        "outputCostPerToken",
      ] as const) {
        const oldVal = oldEntry.pricing[field];
        const newVal = newEntry.pricing[field];
        if (oldVal !== undefined && newVal !== undefined && oldVal !== newVal) {
          changelog.pricingChanged.push({
            modelId: id,
            field,
            oldValue: oldVal,
            newValue: newVal,
          });

          // Anomaly detection
          if (oldVal > 0) {
            const changeRatio = (newVal - oldVal) / oldVal;
            if (changeRatio < -0.5) {
              changelog.anomalies.push({
                modelId: id,
                type: "pricing_drop",
                description: `${field} dropped >50%: ${oldVal} → ${newVal}`,
              });
            }
            if (changeRatio > 1.0) {
              changelog.anomalies.push({
                modelId: id,
                type: "pricing_increase",
                description: `${field} increased >100%: ${oldVal} → ${newVal}`,
              });
            }
          }
        }
      }
    }

    // Capability changes
    if (oldEntry.capabilities && newEntry.capabilities) {
      const allKeys = new Set([
        ...Object.keys(oldEntry.capabilities),
        ...Object.keys(newEntry.capabilities),
      ]);

      for (const key of allKeys) {
        const capKey = key as keyof ModelCapabilities;
        const oldVal = oldEntry.capabilities[capKey];
        const newVal = newEntry.capabilities[capKey];
        if (oldVal !== newVal) {
          changelog.capabilitiesChanged.push({
            modelId: id,
            field: key,
            oldValue: oldVal,
            newValue: newVal,
          });

          // Anomaly: model lost a capability
          if (oldVal === true && newVal !== true) {
            changelog.anomalies.push({
              modelId: id,
              type: "capability_lost",
              description: `Lost capability: ${key}`,
            });
          }
        }
      }
    }
  }

  // Anomaly: model count decrease > 10%
  const existingCount = existingIds.size;
  const newCount = newIds.size;
  if (existingCount > 0 && newCount < existingCount * 0.9) {
    changelog.anomalies.push({
      modelId: "_global",
      type: "model_count_decrease",
      description: `Model count decreased >10%: ${existingCount} → ${newCount}`,
    });
  }

  return changelog;
}

// ─── PR Body Generation ─────────────────────────────────────────

export function generatePRBody(changelog: SyncChangelog): string {
  const lines: string[] = [];

  lines.push("## Model Registry Sync");
  lines.push("");

  // Anomalies first (prominent)
  if (changelog.anomalies.length > 0) {
    lines.push("> **Warning: Anomalies detected**");
    lines.push(">");
    for (const a of changelog.anomalies) {
      lines.push(`> - ${a.type}: ${a.description} (${a.modelId})`);
    }
    lines.push("");
  }

  if (changelog.added.length > 0) {
    lines.push(`### Models Added (${changelog.added.length})`);
    for (const id of changelog.added.slice(0, 50)) {
      lines.push(`- ${id}`);
    }
    if (changelog.added.length > 50) {
      lines.push(`- ...and ${changelog.added.length - 50} more`);
    }
    lines.push("");
  }

  if (changelog.deprecated.length > 0) {
    lines.push(`### Models Deprecated (${changelog.deprecated.length})`);
    lines.push(
      "These models are missing from their upstream source and have been " +
        "tombstoned with today's date. They remain in `models.json` for " +
        "historical pricing/audit but are excluded from the editor schema."
    );
    lines.push("");
    for (const id of changelog.deprecated.slice(0, 50)) {
      lines.push(`- ${id}`);
    }
    if (changelog.deprecated.length > 50) {
      lines.push(`- ...and ${changelog.deprecated.length - 50} more`);
    }
    lines.push("");
  }

  if (changelog.resurrected.length > 0) {
    lines.push(`### Models Resurrected (${changelog.resurrected.length})`);
    lines.push(
      "These models reappeared upstream after a previous deprecation and " +
        "are once again available in the editor schema."
    );
    lines.push("");
    for (const id of changelog.resurrected.slice(0, 50)) {
      lines.push(`- ${id}`);
    }
    if (changelog.resurrected.length > 50) {
      lines.push(`- ...and ${changelog.resurrected.length - 50} more`);
    }
    lines.push("");
  }

  if (changelog.pricingChanged.length > 0) {
    lines.push(`### Pricing Changes (${changelog.pricingChanged.length})`);
    lines.push("| Model | Field | Old | New |");
    lines.push("|-------|-------|-----|-----|");
    for (const c of changelog.pricingChanged.slice(0, 50)) {
      lines.push(`| ${c.modelId} | ${c.field} | ${c.oldValue} | ${c.newValue} |`);
    }
    lines.push("");
  }

  if (changelog.capabilitiesChanged.length > 0) {
    lines.push(
      `### Capability Changes (${changelog.capabilitiesChanged.length})`
    );
    lines.push("| Model | Field | Old | New |");
    lines.push("|-------|-------|-----|-----|");
    for (const c of changelog.capabilitiesChanged.slice(0, 50)) {
      lines.push(`| ${c.modelId} | ${c.field} | ${c.oldValue} | ${c.newValue} |`);
    }
    lines.push("");
  }

  if (
    changelog.added.length === 0 &&
    changelog.deprecated.length === 0 &&
    changelog.resurrected.length === 0 &&
    changelog.pricingChanged.length === 0 &&
    changelog.capabilitiesChanged.length === 0
  ) {
    lines.push("No significant changes detected.");
  }

  return lines.join("\n");
}

function hasChangelogChanges(changelog: SyncChangelog): boolean {
  return (
    changelog.added.length > 0 ||
    changelog.deprecated.length > 0 ||
    changelog.resurrected.length > 0 ||
    changelog.pricingChanged.length > 0 ||
    changelog.capabilitiesChanged.length > 0
  );
}

// ─── Main Orchestration ─────────────────────────────────────────

async function main() {
  try {
    // Fetch from all sources
    const litellmModels = await fetchLiteLLM();

    let openrouterModels = new Map<string, Omit<ModelEntry, "id">>();
    try {
      openrouterModels = await fetchOpenRouter();
    } catch (err) {
      console.warn(
        "Warning: OpenRouter fetch failed, continuing with LiteLLM only:",
        err
      );
    }

    // Merge
    const merged = mergeModels(litellmModels, openrouterModels);

    // Sanitize context values (upstream data can have inconsistencies)
    sanitizeModels(merged);

    // Merge overrides.json so models defined there survive the nightly rewrite.
    // This mirrors the runtime merge in ModelRegistryImpl — the source of truth
    // for override data is overrides.json; models.json is a snapshot of LiteLLM
    // + OpenRouter + those overrides baked in.
    if (fs.existsSync(OVERRIDES_PATH)) {
      try {
        const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf-8"));
        const overrides = overridesFileSchema.parse(raw);
        for (const [id, fields] of Object.entries(overrides.models)) {
          const existing = merged.get(id);
          if (existing) {
            merged.set(id, { ...existing, ...fields });
          } else if (fields.provider && fields.displayName && fields.mode) {
            merged.set(id, fields as Omit<ModelEntry, "id">);
          }
        }
        console.log(`Applied ${Object.keys(overrides.models).length} overrides from overrides.json`);
      } catch (err) {
        console.warn("Warning: Could not load or apply overrides.json:", err);
      }
    }

    // Load existing models.json for deprecation handling and changelog
    let existingModels: Record<string, Omit<ModelEntry, "id">> = {};
    if (fs.existsSync(OUTPUT_PATH)) {
      try {
        const existing = JSON.parse(
          fs.readFileSync(OUTPUT_PATH, "utf-8")
        ) as ModelsFile;
        existingModels = existing.models;
      } catch {
        console.warn("Warning: Could not parse existing models.json");
      }
    }

    // Handle deprecation — also preserves model ordering from the previous
    // models.json so reviewers see clean per-field diffs instead of moved blocks.
    const deprecationDelta = handleDeprecation(merged, existingModels);

    // Generate changelog
    const changelog = generateChangelog(merged, existingModels, deprecationDelta);

    // Build output
    const modelsRecord: Record<string, Omit<ModelEntry, "id">> = {};
    for (const [id, entry] of merged) {
      modelsRecord[id] = entry;
    }

    const output: ModelsFile = {
      version: "1.0.0",
      generatedAt: new Date().toISOString(),
      sources: {
        litellm: {
          fetchedAt: new Date().toISOString(),
          modelCount: litellmModels.size,
        },
        ...(openrouterModels.size > 0
          ? {
              openrouter: {
                fetchedAt: new Date().toISOString(),
                modelCount: openrouterModels.size,
              },
            }
          : {}),
      },
      models: modelsRecord,
    };

    // Validate output
    const parseResult = modelsFileSchema.safeParse(output);
    if (!parseResult.success) {
      console.error("Validation failed:", parseResult.error.issues);
      process.exit(1);
    }

    // Write to disk
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(`\nModels written to ${OUTPUT_PATH}`);
    console.log(`Total models: ${Object.keys(output.models).length}`);

    // Print changelog summary
    console.log(`\nChangelog:`);
    console.log(`  Added: ${changelog.added.length}`);
    console.log(`  Deprecated: ${changelog.deprecated.length}`);
    console.log(`  Resurrected: ${changelog.resurrected.length}`);
    console.log(`  Pricing changes: ${changelog.pricingChanged.length}`);
    console.log(`  Capability changes: ${changelog.capabilitiesChanged.length}`);
    console.log(`  Anomalies: ${changelog.anomalies.length}`);

    // Write PR body if changes detected
    if (hasChangelogChanges(changelog)) {
      const prBody = generatePRBody(changelog);
      const prBodyPath = "/tmp/sync-pr-body.md";
      fs.writeFileSync(prBodyPath, prBody);
      console.log(`\nPR body written to ${prBodyPath}`);
    }
  } catch (error) {
    console.error("Error syncing model registry:", error);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported for testing)
const isDirectRun =
  require.main === module ||
  process.argv[1]?.endsWith("sync-model-registry.ts");
if (isDirectRun) {
  main();
}
