// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Shared classification core for the fixture sanitizer and the leak scanner.
// One source of truth: the leak scanner accepts a string IFF it is (a) a
// keep-shaped value for its key, or (b) a sanitizer output token. Any
// sanitizer bug that lets raw content through therefore fails the scan.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

/** Non-reversible per-process salt: same input → same token within a run,
 * tokens are not dictionary-reversible across runs. */
const RUN_SALT = randomBytes(16).toString("hex");

export function token(value, len = 6) {
  return createHash("sha256").update(RUN_SALT).update(String(value)).digest("hex").slice(0, len);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const ENUMISH = /^[a-z0-9_.-]{1,60}$/i;
const HEXISH = /^[0-9a-f-]{8,64}$/i;

/** Keys whose values are kept verbatim when they match the shape. A value
 * under one of these keys that does NOT match falls through to rewriting. */
export const KEEP_KEYS = {
  uuid: UUID,
  parentUuid: UUID,
  sessionId: UUID,
  leafUuid: UUID,
  messageId: HEXISH,
  requestId: /^req_[A-Za-z0-9]+$/,
  tool_use_id: /^(toolu_|srvtoolu_)[A-Za-z0-9]+$/,
  id: /^((toolu_|srvtoolu_|msg_|req_)[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  agentId: /^[0-9a-f]{8,24}$/i,
  bridgeSessionId: /^cse_[A-Za-z0-9]+$/,
  key: /^v\d+:[0-9a-f]{16,}$/,
  timestamp: ISO_TS,
  version: /^\d+\.\d+\.\d+/,
  model: /^[a-z0-9][a-z0-9.:_/-]*$/i,
  type: ENUMISH,
  subtype: ENUMISH,
  role: ENUMISH,
  level: ENUMISH,
  mode: ENUMISH,
  permissionMode: ENUMISH,
  operation: ENUMISH,
  entrypoint: ENUMISH,
  userType: ENUMISH,
  service_tier: ENUMISH,
  inference_geo: ENUMISH,
  stop_reason: ENUMISH,
  stop_sequence: ENUMISH,
  status: ENUMISH,
};

/** Harness-emitted constants preserved (prefix) so downstream heuristics —
 * interrupt counting, caveat/system filtering, rejection detection — still
 * fire on fixtures. The remainder of the string is x-filled. */
export const HARNESS_CONSTANTS = [
  "[Request interrupted by user",
  "The user doesn't want to proceed",
  "File does not exist",
  "File has not been read yet",
  "String to replace not found in file",
  "Command timed out after",
  "Caveat: The messages below were generated",
  "API Error",
  "Error:",
  "<system-reminder>",
  "<command-name>",
  "<local-command-stdout>",
];

/** Built-in / harness tool names are not user content — keep. */
const TOOL_NAME = /^[A-Z][A-Za-z0-9_]{1,60}$/;

/** Sanitizer output grammar. leak-scan accepts exactly: keep-shaped values,
 * these tokens, or a harness constant prefix + x-fill. */
export const PLACEHOLDER_PATTERNS = [
  /^[<[]?[x\n]*$/, // x-filled text (optional preserved leading marker)
  /^§str:\d+§$/, // long text collapsed, original length recorded
  /^§sig:\d+§$/, // thinking-block signature
  /^\{"§malformed-line§":x*$/, // deliberately-broken line, brokenness preserved
  /^\/sanitized\/p[0-9a-f]{6}(\/(f[0-9a-f]{6}(\.[a-z0-9]{1,10})?|d[0-9a-f]{6}))*$/i,
  /^branch-[0-9a-f]{6}$/,
  /^https:\/\/example\.invalid\/[0-9a-f]{8}$/,
  /^user-[0-9a-f]{6}@example\.invalid$/,
  /^org-[0-9a-f]{4}\/repo-[0-9a-f]{4}$/,
  /^skill-[0-9a-f]{6}$/,
  /^agent-[0-9a-f]{6}$/,
  /^tool-[0-9a-f]{6}$/,
  /^slug-[0-9a-f]{6}$/,
  /^k-[0-9a-f]{6}$/,
  /^mcp__s[0-9a-f]{4}(__t[0-9a-f]{4})?$/,
];

/**
 * Committed floor for the raw-byte needles that must never appear in a
 * sanitized fixture. Product and org names, plus a catch-all for any real home
 * path (`/Users/x`, `/Users/xx`, … are the sanitizer's own output and so are
 * exempt).
 *
 * Deliberately holds no personal identifiers. A needle list has to name what it
 * protects, which makes a committed one a description of who and what is worth
 * targeting. Personal needles come from the two additive sources below instead,
 * so the coverage a contributor gets is generic and the coverage this repo's
 * maintainers get is complete.
 */
const COMMITTED_NEEDLE_SOURCE = "agentmark|puzzlet|outerlayer-migration|\\/Users\\/(?!x+\\b)";

const EXTRA_NEEDLES_FILE = new URL("./.sanitize-extra-needles", import.meta.url);

/** Escape every regex metacharacter: extra needles are literals, not patterns. */
function escapeLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Personal needles, from `SANITIZE_EXTRA_NEEDLES` (comma-separated) and/or a
 * gitignored `.sanitize-extra-needles` file (one per line, `#` comments).
 *
 * Both sources are strictly additive — they are appended as alternatives to the
 * committed floor and can never remove or weaken it. Blank entries are dropped:
 * an empty alternative matches the empty string, which would make every value
 * look like a leak.
 */
function extraNeedles() {
  const raw = [...(process.env.SANITIZE_EXTRA_NEEDLES ?? "").split(",")];
  try {
    raw.push(...readFileSync(EXTRA_NEEDLES_FILE, "utf8").split("\n"));
  } catch {
    // No local file is the normal case, including every contributor's checkout.
  }
  return raw.map((n) => n.trim()).filter((n) => n.length > 0 && !n.startsWith("#"));
}

/** Raw-byte needles that must never appear in a sanitized fixture. */
export const FORBIDDEN_NEEDLES = new RegExp(
  [COMMITTED_NEEDLE_SOURCE, ...extraNeedles().map(escapeLiteral)].join("|"),
  "i",
);

const PATH_KEYS = new Set(["cwd", "path", "file_path", "filePath", "notebook_path", "workdir"]);
const EMAILISH = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Relative or absolute file path (no whitespace, ≥1 separator). */
const PATHISH = /^~?\.{0,2}[\w.@-]*(\/[\w.@-]+)+\/?$/;
/** Object keys kept verbatim: plain identifier-ish, no separators, no needles. */
const SAFE_KEY = /^[A-Za-z0-9_$@§][A-Za-z0-9_.:$§-]{0,60}$/;

/**
 * Decide how to treat a string. Returns "keep" or a rewrite rule name:
 * path | branch | url | email | repo | skill | agent | tool | slug | sig | text
 */
export function classify(key, value, ctx = {}) {
  const keep = KEEP_KEYS[key];
  if (keep && keep.test(value)) return "keep";
  if (key === "gitBranch") return "branch";
  if (key === "prRepository") return "repo";
  if (key === "attributionSkill") return "skill";
  if (key === "attributionAgent" || key === "subagent_type") return "agent";
  if (key === "attributionMcpServer" || key === "attributionMcpTool") return "mcp";
  if (key === "slug") return "slug";
  if (key === "signature") return "sig";
  if (key === "name" && ctx.inToolUse) return TOOL_NAME.test(value) ? "keep" : value.startsWith("mcp__") ? "mcp" : "tool";
  if (ctx.inToolNameList) return TOOL_NAME.test(value) ? "keep" : value.startsWith("mcp__") ? "mcp" : "tool";
  if (PATH_KEYS.has(key) || value.startsWith("/") || value.startsWith("~/")) return "path";
  if (/^[a-z]+:\/\//i.test(value)) return "url";
  if (EMAILISH.test(value)) return "email";
  if (PATHISH.test(value)) return "path";
  return "text";
}

/** True when an object key may be kept verbatim in a fixture. */
export function isSafeKey(key) {
  return SAFE_KEY.test(key) && !FORBIDDEN_NEEDLES.test(key);
}

/** Sanitize an object key: identifier-ish keys stay; path-like keys become
 * path tokens; anything else becomes a stable `k-<hash>` token. */
export function sanitizeKey(key) {
  if (isSafeKey(key)) return key;
  if (PATHISH.test(key) || key.startsWith("/") || key.startsWith("~/")) return rewrite("path", key);
  return `k-${token(key)}`;
}

const LONG_TEXT = 240;
const EXT_OK = /\.([a-z0-9]{1,10})$/i;

export function rewrite(rule, value) {
  switch (rule) {
    case "keep":
      return value;
    case "branch":
      return `branch-${token(value)}`;
    case "url":
      return `https://example.invalid/${token(value, 8)}`;
    case "email":
      return `user-${token(value)}@example.invalid`;
    case "repo":
      return `org-${token(value, 4)}/repo-${token(`r:${value}`, 4)}`;
    case "skill":
      return `skill-${token(value)}`;
    case "agent":
      return `agent-${token(value)}`;
    case "tool":
      return `tool-${token(value)}`;
    case "mcp": {
      const [server, ...rest] = value.replace(/^mcp__/, "").split("__");
      const tool = rest.join("__");
      return tool ? `mcp__s${token(server, 4)}__t${token(tool, 4)}` : `mcp__s${token(server, 4)}`;
    }
    case "slug":
      return `slug-${token(value)}`;
    case "sig":
      return `§sig:${value.length}§`;
    case "path": {
      const segs = value.replace(/^~\//, "/").split("/").filter(Boolean);
      const last = segs[segs.length - 1] ?? "";
      const extMatch = EXT_OK.exec(last);
      const dirSegs = segs.slice(0, -1);
      const root = `/sanitized/p${token(dirSegs[0] ?? value)}`;
      const mids = dirSegs.slice(1).map((s) => `d${token(s)}`);
      const leaf = last
        ? extMatch
          ? `f${token(last)}${extMatch[0].toLowerCase()}`
          : `d${token(last)}`
        : "";
      return [root, ...mids, ...(leaf ? [leaf] : [])].join("/");
    }
    case "text": {
      const constant = HARNESS_CONSTANTS.find((c) => value.startsWith(c));
      if (constant) {
        return constant + fillText(value.slice(constant.length));
      }
      if (value.length > LONG_TEXT) return `§str:${value.length}§`;
      const marker = value[0] === "<" || value[0] === "[" ? value[0] : "";
      return marker + fillText(value.slice(marker.length));
    }
    default:
      throw new Error(`unknown rewrite rule: ${rule}`);
  }
}

/** Replace every non-newline character with 'x' (length + line structure preserved). */
function fillText(s) {
  return s.replace(/[^\n]/g, "x");
}

/** Recursively sanitize one parsed JSONL line object. */
export function sanitizeValue(node, key = "", ctx = {}) {
  if (typeof node === "string") return rewrite(classify(key, node, ctx), node);
  if (Array.isArray(node)) {
    const childCtx = key === "addedNames" || key === "removedNames" ? { ...ctx, inToolNameList: true } : ctx;
    return node.map((item) => sanitizeValue(item, key, childCtx));
  }
  if (typeof node === "object" && node !== null) {
    const isToolUse = node.type === "tool_use" || node.type === "server_tool_use" || node.type === "mcp_tool_use";
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[sanitizeKey(k)] = sanitizeValue(v, k, { ...ctx, inToolUse: isToolUse });
    }
    return out;
  }
  return node; // number | boolean | null
}

/** True when a string is an acceptable byte sequence in a sanitized fixture. */
export function isSanitizedString(key, value, ctx = {}) {
  if (value === "") return true;
  // universally harmless shapes, regardless of key (timestamps under
  // sanitized keys, ids in unknown positions)
  if (ISO_TS.test(value) || UUID.test(value)) return true;
  const keep = KEEP_KEYS[key];
  if (keep && keep.test(value)) return true;
  if ((key === "name" && ctx.inToolUse) || ctx.inToolNameList) {
    if (TOOL_NAME.test(value)) return true;
  }
  if (PLACEHOLDER_PATTERNS.some((p) => p.test(value))) return true;
  const constant = HARNESS_CONSTANTS.find((c) => value.startsWith(c));
  if (constant && /^[x\n]*$/.test(value.slice(constant.length))) return true;
  // numbers-as-strings are harmless
  if (/^[0-9][0-9., ]*$/.test(value)) return true;
  return false;
}

/** Scan one parsed line object; returns violations [{path, sample}]. */
export function scanValue(node, key = "", ctx = {}, path = "$", out = []) {
  if (typeof node === "string") {
    if (!isSanitizedString(key, node, ctx)) {
      out.push({ path, sample: node.slice(0, 80) });
    }
    return out;
  }
  if (Array.isArray(node)) {
    const childCtx = key === "addedNames" || key === "removedNames" ? { ...ctx, inToolNameList: true } : ctx;
    node.forEach((item, i) => scanValue(item, key, childCtx, `${path}[${i}]`, out));
    return out;
  }
  if (typeof node === "object" && node !== null) {
    const isToolUse = node.type === "tool_use" || node.type === "server_tool_use" || node.type === "mcp_tool_use";
    for (const [k, v] of Object.entries(node)) {
      if (!isSafeKey(k) && !PLACEHOLDER_PATTERNS.some((p) => p.test(k))) {
        out.push({ path: `${path}.(key)`, sample: k.slice(0, 80) });
      }
      scanValue(v, k, { ...ctx, inToolUse: isToolUse }, `${path}.${k}`, out);
    }
    return out;
  }
  return out;
}
