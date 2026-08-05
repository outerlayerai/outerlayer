// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Cursor (agent chats) source adapter. Each chat is a SQLite db at
 *   ~/.cursor/chats/<md5(workspacePath)>/<chatId>/store.db
 * with two tables:
 *   meta(key, value)  — value is HEX-ENCODED JSON: { agentId, name, mode,
 *                       createdAt, lastUsedModel, latestRootBlobId }
 *   blobs(id, data)   — content-addressed. The root blob is a protobuf-framed
 *                       list of 32-byte child hashes (field 1, in conversation
 *                       order); every child blob is PLAIN JSON — one message
 *                       in the AI-SDK shape:
 *   { role: "system" | "user" | "assistant" | "tool",
 *     content: string | [{ type: "text"|"reasoning"|"tool-call"|"tool-result", … }] }
 *
 * Workspace resolution: the chat dir name is md5 of the workspace path, and
 * ~/.cursor/projects/<encoded-path>/ names the workspaces — md5 the decoded
 * candidates once and reverse-lookup.
 *
 * The format is Cursor-internal and unversioned, so this adapter is
 * defensive-by-construction: unknown shapes are counted, never thrown; the
 * failure mode is a thinner session, never a wrong one. No token usage is
 * stored anywhere in the format → sessions are honestly unpriced.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parseAgentSession, SCHEMA_VERSION, type AgentSession, type Turn, type ToolCall } from "@outerlayer/session-schema";
import type { ParseResult } from "./claude-code/parse.js";
import { WarningCollector, WARNING_CODES } from "../warnings.js";
import type { TranscriptEntry } from "./claude-code/discover.js";
import type { SourceAdapter } from "./types.js";

/** Minimal structural type for the `node:sqlite` surface this adapter uses.
 * Declared locally so the swap needs no @types/node bump (the repo pins v20,
 * which predates the node:sqlite types). */
interface NodeSqliteStatement {
  get(...params: unknown[]): unknown;
}
interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeSqliteDatabase;
}

const TEXT_CAP = 4000;
const INPUT_CAP = 4000;
const OUTPUT_CAP = 8000;

/** Default Cursor chat root. */
export function defaultCursorChatsDir(): string {
  return join(homedir(), ".cursor", "chats");
}

/** Default Cursor projects dir (workspace-path candidates). */
export function defaultCursorProjectsDir(): string {
  return join(homedir(), ".cursor", "projects");
}

/** Find chat dbs under the cursor chats root: <wsHash>/<chatId>/store.db. */
export function findCursorChats(root = defaultCursorChatsDir()): TranscriptEntry[] {
  const found: TranscriptEntry[] = [];
  let wsDirs: string[];
  try {
    wsDirs = readdirSync(root);
  } catch {
    return []; // cursor isn't installed — friendly empty
  }
  for (const ws of wsDirs) {
    let chatDirs: string[];
    try {
      chatDirs = readdirSync(join(root, ws));
    } catch {
      continue;
    }
    for (const chat of chatDirs) {
      const file = join(root, ws, chat, "store.db");
      try {
        const st = statSync(file);
        if (st.size > 0) found.push({ file, mtimeMs: st.mtimeMs, bytes: st.size, isSubagent: false });
      } catch {
        continue;
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** `<root>/<wsHash>/<chatId>/store.db` → chatId (fallback session id). */
export function cursorChatIdFromPath(file: string): string {
  const parts = file.split(/[/\\]/);
  return parts[parts.length - 2] ?? file;
}

/**
 * md5(workspacePath) → workspacePath, built from the projects dir's encoded
 * names (`Users-<user>-Development-<repo>` → `/Users/<user>/Development/<repo>`).
 * Dash-in-name paths are ambiguous by construction, so every dash split is
 * tried; md5 equality is the arbiter. Memoized per projects dir.
 */
const wsMapCache = new Map<string, Map<string, string>>();
export function workspacesByHash(projectsDir = defaultCursorProjectsDir()): Map<string, string> {
  const cached = wsMapCache.get(projectsDir);
  if (cached) return cached;
  const map = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(projectsDir);
  } catch {
    /* no projects dir — hashes stay unresolved */
  }
  for (const name of names) {
    for (const candidate of decodedPathCandidates(name)) {
      map.set(createHash("md5").update(candidate).digest("hex"), candidate);
    }
  }
  wsMapCache.set(projectsDir, map);
  return map;
}

/** All plausible absolute paths for an encoded dir name. Dashes are either
 * separators or literal; cap the fan-out to keep degenerate names cheap. */
function decodedPathCandidates(encoded: string): string[] {
  const segs = encoded.split("-");
  if (segs.length > 14) return [sep + segs.join(sep)]; // fan-out cap: take the plain split
  const out: string[] = [];
  const build = (i: number, cur: string): void => {
    if (out.length >= 256) return;
    if (i === segs.length) {
      out.push(cur);
      return;
    }
    build(i + 1, cur + sep + segs[i]); // dash as path separator
    if (i > 0) build(i + 1, cur + "-" + segs[i]); // dash literal in a segment
  };
  build(0, "");
  return out;
}

interface CursorMeta {
  agentId?: string;
  name?: string;
  mode?: string;
  createdAt?: number;
  lastUsedModel?: string;
  latestRootBlobId?: string;
}

/** Extract the ordered 32-byte child hashes from the protobuf-framed root. */
export function rootChildIds(root: Buffer): string[] {
  const ids: string[] = [];
  let i = 0;
  while (i < root.length) {
    let tag = 0;
    let shift = 0;
    let ok = false;
    while (i < root.length) {
      const b = root[i++]!;
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) {
        ok = true;
        break;
      }
      shift += 7;
    }
    if (!ok) break;
    const field = tag >> 3;
    const wire = tag & 7;
    if (wire === 2) {
      let len = 0;
      let s = 0;
      while (i < root.length) {
        const b = root[i++]!;
        len |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (field === 1 && len === 32 && i + len <= root.length) ids.push(root.subarray(i, i + len).toString("hex"));
      i += len;
    } else if (wire === 0) {
      while (i < root.length && root[i++]! & 0x80);
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else break; // unknown wire type — stop, keep what we have
  }
  return ids;
}

export interface CursorParseOptions {
  fallbackId?: string;
  captureTier?: AgentSession["captureTier"];
  /** md5(workspacePath) → path map (from workspacesByHash). */
  workspaceByHash?: Map<string, string>;
  /** The chat's workspace hash (from the path), for cwd resolution. */
  workspaceHash?: string;
  /** endedAt approximation — the db file's mtime (messages carry no timestamps). */
  mtimeMs?: number;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "edit_file", "write_file", "apply_patch", "create_file", "search_replace"]);

export function parseCursorChat(dbPath: string, opts: CursorParseOptions = {}): ParseResult {
  const warnings = new WarningCollector();
  const stats = { lines: 0, parsed: 0, skipped: 0, unmapped: 0 };

  let db: NodeSqliteDatabase | null = null;
  let meta: CursorMeta = {};
  let messages: unknown[] = [];
  try {
    // node:sqlite is a Node builtin (>=22.5), loaded lazily via createRequire
    // for two reasons: its one-time ExperimentalWarning fires only when a
    // Cursor db is actually parsed (not on every sync), and on older Node the
    // require throws and the catch below simply skips Cursor while every other
    // source still syncs. Being a builtin, it adds NO native dependency — the
    // bundled CLI stays self-contained.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as NodeSqliteModule;
    db = new DatabaseSync(dbPath, { readOnly: true });
    const metaRow = db.prepare("SELECT value FROM meta LIMIT 1").get() as { value: string } | undefined;
    if (metaRow?.value) {
      try {
        meta = JSON.parse(Buffer.from(metaRow.value, "hex").toString("utf8")) as CursorMeta;
      } catch {
        warnings.add(WARNING_CODES.malformedLine, "meta not hex-json");
      }
    }
    if (meta.latestRootBlobId) {
      // node:sqlite returns BLOB columns as Uint8Array, not Buffer — wrap so
      // the protobuf walk and JSON decode (both Buffer-method callers) work.
      const rootRow = db.prepare("SELECT data FROM blobs WHERE id = ?").get(meta.latestRootBlobId) as
        | { data: Uint8Array }
        | undefined;
      if (rootRow) {
        const getBlob = db.prepare("SELECT data FROM blobs WHERE id = ?");
        for (const id of rootChildIds(Buffer.from(rootRow.data))) {
          stats.lines += 1;
          const child = getBlob.get(id) as { data: Uint8Array } | undefined;
          if (!child) {
            stats.skipped += 1;
            continue;
          }
          try {
            messages.push(JSON.parse(Buffer.from(child.data).toString("utf8")));
            stats.parsed += 1;
          } catch {
            stats.unmapped += 1; // non-JSON child (unknown blob kind) — counted, never fatal
          }
        }
      }
    }
  } catch {
    // unreadable/corrupt db — not a session
    return { session: null, warnings: warnings.histogram(), stats, versions: [], blobs: [] };
  } finally {
    db?.close();
  }

  const model = typeof meta.lastUsedModel === "string" && meta.lastUsedModel ? meta.lastUsedModel : undefined;
  const turns: Turn[] = [];
  // toolCallId → call (tool-result messages resolve them)
  const openCalls = new Map<string, ToolCall>();
  let lastAssistant: Turn | null = null;

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const content = m.content;
    const items: Record<string, unknown>[] = Array.isArray(content)
      ? (content.filter((c) => c && typeof c === "object") as Record<string, unknown>[])
      : [];
    const textOf = (type: string): string =>
      items
        .filter((c) => c.type === type && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");

    switch (m.role) {
      case "system":
        stats.unmapped += 1; // harness prompt, not conversation
        break;
      case "user": {
        const text = typeof content === "string" ? content : textOf("text");
        if (text.trim()) {
          turns.push({ index: turns.length, role: "user", toolCalls: [], text: text.trim().slice(0, TEXT_CAP) });
          lastAssistant = null;
        }
        break;
      }
      case "assistant": {
        const text = typeof content === "string" ? content : textOf("text");
        const thinking = textOf("reasoning");
        const turn: Turn = {
          index: turns.length,
          role: "assistant",
          toolCalls: [],
          ...(text.trim() ? { text: text.trim().slice(0, TEXT_CAP) } : {}),
          ...(thinking.trim() ? { thinking: thinking.trim().slice(0, TEXT_CAP) } : {}),
          ...(model ? { model } : {}),
        };
        for (const c of items) {
          if (c.type !== "tool-call") continue;
          const name = typeof c.toolName === "string" ? c.toolName : "unknown";
          const args = c.args && typeof c.args === "object" ? (c.args as Record<string, unknown>) : {};
          const file = firstString(args, ["file_path", "path", "target_file", "filePath"]);
          const call: ToolCall = {
            name,
            status: "ok",
            isEdit: EDIT_TOOLS.has(name),
            ...(file ? { file } : {}),
            input: JSON.stringify(args).slice(0, INPUT_CAP),
          };
          turn.toolCalls.push(call);
          if (typeof c.toolCallId === "string") openCalls.set(c.toolCallId, call);
        }
        turns.push(turn);
        lastAssistant = turn;
        break;
      }
      case "tool": {
        for (const c of items) {
          if (c.type !== "tool-result") continue;
          const call = typeof c.toolCallId === "string" ? openCalls.get(c.toolCallId) : undefined;
          if (!call) {
            stats.unmapped += 1;
            continue;
          }
          const result = c.result ?? c.output ?? c.content;
          const out = typeof result === "string" ? result : JSON.stringify(result ?? "");
          call.output = out.slice(0, OUTPUT_CAP);
          // failures carry no flag — they're embedded in the result text
          // ("Finished with exit code 1"), same pattern as codex
          const exit = /(?:finished with|exited with|process exited with)\s*(?:exit )?code[: ]*(\d+)/i.exec(out);
          if (c.isError === true || (exit && exit[1] !== "0") || (result && typeof result === "object" && (result as Record<string, unknown>).error !== undefined)) {
            call.status = "error";
            const lines = out.split("\n").filter((l) => l.trim());
            call.errorSignature = (lines.find((l) => !/exit code/i.test(l)) ?? lines[0] ?? "error").slice(0, 300);
          }
          if (typeof c.toolCallId === "string") openCalls.delete(c.toolCallId);
        }
        void lastAssistant;
        break;
      }
      default:
        stats.unmapped += 1;
    }
  }

  if (turns.length === 0) {
    return { session: null, warnings: warnings.histogram(), stats, versions: [], blobs: [] };
  }

  const id = (typeof meta.agentId === "string" && meta.agentId) || opts.fallbackId || "";
  const cwd = opts.workspaceHash && opts.workspaceByHash ? opts.workspaceByHash.get(opts.workspaceHash) : undefined;
  const startedAt = typeof meta.createdAt === "number" && meta.createdAt > 0 ? new Date(meta.createdAt).toISOString() : new Date(0).toISOString();
  const endedAt = opts.mtimeMs && opts.mtimeMs > 0 ? new Date(opts.mtimeMs).toISOString() : undefined;

  // no usage/token data exists anywhere in this format — unpriced, never guessed
  if (model) warnings.add(WARNING_CODES.unknownModelCost, `${model} (cursor stores no token usage)`);

  const session: AgentSession = {
    schemaVersion: SCHEMA_VERSION,
    id,
    agent: { type: "cursor", ...(typeof meta.mode === "string" && meta.mode ? { entrypoint: meta.mode } : {}) },
    env: { ...(cwd ? { cwd } : {}) },
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    models: model ? [model] : [],
    turns,
    events: [],
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null },
    ...(typeof meta.name === "string" && meta.name ? { title: meta.name.slice(0, 80) } : {}),
    captureTier: opts.captureTier ?? "full",
    warnings: warnings.toArray(),
  };

  const validated = parseAgentSession(session);
  return { session: validated, warnings: warnings.histogram(), stats, versions: [], blobs: [] };
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) if (typeof obj[k] === "string" && obj[k]) return obj[k] as string;
  return undefined;
}

export const cursorAdapter: SourceAdapter = {
  id: "cursor",
  discover(roots) {
    return findCursorChats(roots.cursorRoot ?? defaultCursorChatsDir());
  },
  parse(entry, opts) {
    const parts = entry.file.split(/[/\\]/);
    return parseCursorChat(entry.file, {
      fallbackId: cursorChatIdFromPath(entry.file),
      workspaceHash: parts[parts.length - 3],
      workspaceByHash: workspacesByHash(opts.roots.cursorProjectsRoot ?? defaultCursorProjectsDir()),
      mtimeMs: entry.mtimeMs,
      ...(opts.captureTier ? { captureTier: opts.captureTier } : {}),
    });
  },
};
