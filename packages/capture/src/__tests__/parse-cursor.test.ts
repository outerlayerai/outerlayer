// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { parseCursorChat, findCursorChats, cursorChatIdFromPath, workspacesByHash, rootChildIds } from "../adapters/cursor.js";
import { scanAll } from "../scan.js";

// ---- fixture builder: a REAL store.db in the observed format ----

function protoFrameHashes(ids: Buffer[]): Buffer {
  // field 1, wire 2: tag byte 0x0a, varint len 32, 32 bytes — repeated
  return Buffer.concat(ids.flatMap((id) => [Buffer.from([0x0a, 32]), id]));
}

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Build <root>/<md5(ws)>/<chatId>/store.db holding `messages` (in order). */
function makeChat(
  root: string,
  workspace: string,
  chatId: string,
  messages: unknown[],
  meta: Record<string, unknown> = {},
): string {
  const wsHash = createHash("md5").update(workspace).digest("hex");
  const dir = join(root, wsHash, chatId);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "store.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  const childBufs = messages.map((m) => Buffer.from(JSON.stringify(m), "utf8"));
  const childIds = childBufs.map(sha);
  const ins = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  childBufs.forEach((b, i) => ins.run(childIds[i], b));
  const rootBuf = protoFrameHashes(childIds.map((h) => Buffer.from(h, "hex")));
  const rootId = sha(rootBuf);
  ins.run(rootId, rootBuf);
  const fullMeta = { agentId: chatId, name: "Fix the build", mode: "default", createdAt: 1754670682008, lastUsedModel: "gpt-5", latestRootBlobId: rootId, ...meta };
  db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(fullMeta), "utf8").toString("hex"));
  db.close();
  return dbPath;
}

const MESSAGES = [
  { role: "system", content: "You are an AI coding assistant." },
  { role: "user", content: [{ type: "text", text: "Fix the failing build" }] },
  {
    id: "1",
    role: "assistant",
    content: [
      { type: "reasoning", text: "Look at the build script first" },
      { type: "text", text: "Checking the build." },
      { type: "tool-call", toolCallId: "call_1\nfc_a", toolName: "Shell", args: { command: "yarn build" } },
    ],
  },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1\nfc_a", toolName: "Shell", result: "Finished with exit code 1.\n\nerror TS2307: Cannot find module 'x' at line 3" }] },
  {
    id: "2",
    role: "assistant",
    content: [
      { type: "text", text: "Missing module — fixing the import." },
      { type: "tool-call", toolCallId: "call_2\nfc_b", toolName: "Edit", args: { file_path: "/repo/src/a.ts", old: "x", new: "y" } },
    ],
  },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call_2\nfc_b", toolName: "Edit", result: "OK" }] },
];

let tmp: string;
const WS = "/home/dev/acme";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ol-cursor-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("parseCursorChat — core mapping", () => {
  it("maps meta + messages onto AgentSession: title, model, turns, thinking, cwd, mtime endedAt", () => {
    const dbPath = makeChat(tmp, WS, "chat-1", MESSAGES);
    const wsMap = new Map([[createHash("md5").update(WS).digest("hex"), WS]]);
    const { session } = parseCursorChat(dbPath, {
      workspaceHash: createHash("md5").update(WS).digest("hex"),
      workspaceByHash: wsMap,
      mtimeMs: Date.parse("2026-07-07T12:00:00.000Z"),
    });
    const s = session!;
    expect(s.id).toBe("chat-1");
    expect(s.agent).toEqual({ type: "cursor", entrypoint: "default" });
    expect(s.title).toBe("Fix the build");
    expect(s.models).toEqual(["gpt-5"]);
    expect(s.env).toEqual({ cwd: WS });
    expect(s.startedAt).toBe(new Date(1754670682008).toISOString());
    expect(s.endedAt).toBe("2026-07-07T12:00:00.000Z");
    // system message is NOT a turn
    expect(s.turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"]);
    expect(s.turns[0]!.text).toBe("Fix the failing build");
    expect(s.turns[1]!.thinking).toBe("Look at the build script first");
    expect(s.turns[1]!.model).toBe("gpt-5");
    // unpriced by design: cursor stores no token usage
    expect(s.totals).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: null });
  });

  it("pairs tool-calls with results across messages; embedded exit codes become errors with signatures", () => {
    const dbPath = makeChat(tmp, WS, "chat-2", MESSAGES);
    const { session } = parseCursorChat(dbPath, {});
    const calls = session!.turns.flatMap((t) => t.toolCalls);
    expect(calls).toHaveLength(2);
    const [shell, edit] = calls;
    expect(shell).toMatchObject({ name: "Shell", status: "error", isEdit: false });
    expect(shell!.errorSignature).toContain("Cannot find module");
    expect(shell!.output).toContain("exit code 1");
    expect(edit).toMatchObject({ name: "Edit", status: "ok", isEdit: true, file: "/repo/src/a.ts", output: "OK" });
  });

  it("returns null session for a chat with no reachable messages, and never throws on garbage", () => {
    // meta points at a missing root
    const dbPath = makeChat(tmp, WS, "chat-3", [], { latestRootBlobId: "ff".repeat(32) });
    expect(parseCursorChat(dbPath, {}).session).toBeNull();
    // not a sqlite file at all
    const bogus = join(tmp, "bogus.db");
    writeFileSync(bogus, "definitely not sqlite");
    expect(parseCursorChat(bogus, {}).session).toBeNull();
    // db exists but blobs are garbage: non-JSON children are counted, not fatal
    const wsHash = createHash("md5").update(WS).digest("hex");
    const dir = join(tmp, wsHash, "chat-4");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "store.db"));
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    const junk = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const junkId = sha(junk);
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(junkId, junk);
    const rootBuf = protoFrameHashes([Buffer.from(junkId, "hex")]);
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(sha(rootBuf), rootBuf);
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(
      Buffer.from(JSON.stringify({ agentId: "chat-4", latestRootBlobId: sha(rootBuf) })).toString("hex"),
    );
    db.close();
    const r = parseCursorChat(join(dir, "store.db"), {});
    expect(r.session).toBeNull(); // zero turns
    expect(r.stats.unmapped).toBe(1); // the junk child, counted
  });

  it("rootChildIds tolerates truncation at every byte offset", () => {
    const ids = [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3)];
    const framed = protoFrameHashes(ids);
    expect(rootChildIds(framed)).toHaveLength(3);
    for (let cut = 0; cut < framed.length; cut++) {
      expect(() => rootChildIds(framed.subarray(0, cut))).not.toThrow();
    }
  });
});

describe("cursor discovery + multi-source scan", () => {
  it("workspacesByHash resolves encoded project names via md5, including dash-in-name paths", () => {
    const projects = join(tmp, "projects");
    mkdirSync(join(projects, "home-dev-acme"), { recursive: true });
    mkdirSync(join(projects, "home-dev-my-app"), { recursive: true }); // literal dash in dir name
    const map = workspacesByHash(projects);
    expect(map.get(createHash("md5").update("/home/dev/acme").digest("hex"))).toBe("/home/dev/acme");
    expect(map.get(createHash("md5").update("/home/dev/my-app").digest("hex"))).toBe("/home/dev/my-app");
  });

  it("scanAll sweeps cursor chats alongside the other agents", () => {
    const chatsRoot = join(tmp, "chats");
    makeChat(chatsRoot, WS, "aaaa1111-2222-3333-4444-555566667777", MESSAGES);
    const { report, sessions } = scanAll({
      root: join(tmp, "no-claude"),
      rawRoot: join(tmp, "no-raw"),
      codexRoot: join(tmp, "no-codex"),
      cursorRoot: chatsRoot,
      cursorProjectsRoot: join(tmp, "no-projects"),
    });
    expect(report.byAgent).toEqual({ cursor: 1 });
    expect(sessions[0]!.agent.type).toBe("cursor");
    expect(sessions[0]!.id).toBe("aaaa1111-2222-3333-4444-555566667777");
    expect(cursorChatIdFromPath(join(chatsRoot, "x", "chat-9", "store.db"))).toBe("chat-9");
    expect(findCursorChats(join(tmp, "missing"))).toEqual([]);
  });
});

import { readFileSync as readSourceFile } from "node:fs";
import { fileURLToPath as toPath } from "node:url";

describe("bundle invariant: SQLite access stays dependency-free and lazy", () => {
  // Cursor chats live in a SQLite db, read via the node:sqlite BUILTIN — no
  // native dependency, so the CLI bundle stays self-contained. Two properties
  // must hold, or nothing else would notice: (a) no runtime dependency on the
  // native better-sqlite3, and (b) the builtin is loaded lazily so its
  // ExperimentalWarning fires only when a Cursor db is actually parsed and
  // older Node degrades gracefully rather than crashing the sync path.
  const source = readSourceFile(toPath(new URL("../adapters/cursor.ts", import.meta.url)), "utf8");

  it("does not import the native better-sqlite3 at all", () => {
    expect(source).not.toContain("better-sqlite3");
  });

  it("reads SQLite through the node:sqlite builtin, loaded lazily", () => {
    expect(source).toContain('createRequire(import.meta.url)("node:sqlite")');
    // No top-level static import of node:sqlite either — that would eagerly
    // fire the ExperimentalWarning on every sync.
    const staticImport = /^\s*import\s+[^;]*\bfrom\s+["']node:sqlite["']/m;
    expect(staticImport.test(source)).toBe(false);
  });
});
