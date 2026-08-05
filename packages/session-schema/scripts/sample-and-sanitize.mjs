#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Build the sanitized fixture corpus: stratified sample of real
// Claude Code transcripts from ~/.claude/projects, rewritten so structure,
// usage, timestamps, and line/type shapes survive while every piece of
// content (message text, tool I/O, paths, branches, titles) is replaced by
// grammar tokens. Run on the founder's machine; commit the output.
//
//   node scripts/sample-and-sanitize.mjs [--root <dir>] [--target 40] [--pool 600]

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeValue, token } from "./sanitize-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "fixtures", "raw");
const MANIFEST = join(OUT_DIR, "MANIFEST.json");

const args = process.argv.slice(2);
function argOf(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
}
const ROOT = argOf("--root", join(homedir(), ".claude", "projects"));
const TARGET = Number(argOf("--target", "40"));
const POOL = Number(argOf("--pool", "600"));
const MAX_LINES = 2500;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SANITIZED_BYTES = 600 * 1024;

// --- collect candidate files (depth>1 below a project dir ⇒ subagent transcript)
function walk(dir, depth, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, depth + 1, acc);
    else if (name.endsWith(".jsonl") && st.size > 0 && st.size <= MAX_BYTES) {
      acc.push({ file: p, bytes: st.size, isSubagent: depth > 1 });
    }
  }
  return acc;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function featureScan(entry, maxLines = MAX_LINES) {
  const text = readFileSync(entry.file, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0 || lines.length > maxLines) return null;
  const f = {
    ...entry,
    lines: lines.length,
    versions: new Set(),
    compaction: false,
    apiError: false,
    prLink: false,
    queueOp: false,
    sidechain: false,
    interrupt: false,
    malformed: false,
    parsed: [],
  };
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      f.malformed = true;
      f.parsed.push({ __malformed__: line.length });
      continue;
    }
    f.parsed.push(rec);
    if (typeof rec.version === "string") f.versions.add(rec.version);
    if (rec.type === "summary" || rec.isCompactSummary === true || rec.subtype === "compact_boundary") f.compaction = true;
    if (rec.subtype === "api_error") f.apiError = true;
    if (rec.type === "pr-link") f.prLink = true;
    if (rec.type === "queue-operation") f.queueOp = true;
    if (rec.isSidechain === true) f.sidechain = true;
    if (line.includes("[Request interrupted by user")) f.interrupt = true;
  }
  return f;
}

console.log(`scanning ${ROOT} ...`);
const all = walk(ROOT, 0, []);
console.log(`${all.length} transcript files found; feature-scanning a pool of ${POOL}`);
const pool = [];
for (const entry of shuffle(all).slice(0, POOL)) {
  const f = featureScan(entry);
  if (f) pool.push(f);
}

// Rare features (compaction, api errors, pr links, queue ops) live mostly in
// LONG sessions a random pool under MAX_LINES misses — sweep the whole corpus
// by substring and feature-scan matches under a relaxed cap.
const RARE = [
  ["compaction", /"isCompactSummary":true|"compact_boundary"/, 4],
  ["api_error", /"subtype":"api_error"/, 4],
  ["pr_link", /"type":"pr-link"/, 4],
  ["queue_op", /"type":"queue-operation"/, 4],
];
const RARE_MAX_LINES = 8000;
console.log("sweeping full corpus for rare features ...");
const inPool = new Set(pool.map((f) => f.file));
for (const [name, pattern, want] of RARE) {
  let have = pool.filter((f) => featureFlagFor(name, f)).length;
  if (have >= want) continue;
  for (const entry of shuffle([...all])) {
    if (have >= want) break;
    if (inPool.has(entry.file)) continue;
    let text;
    try {
      text = readFileSync(entry.file, "utf8");
    } catch {
      continue;
    }
    if (!pattern.test(text)) continue;
    const f = featureScan(entry, RARE_MAX_LINES);
    if (f && featureFlagFor(name, f)) {
      pool.push(f);
      inPool.add(entry.file);
      have++;
    }
  }
}
function featureFlagFor(name, f) {
  return { compaction: f.compaction, api_error: f.apiError, pr_link: f.prLink, queue_op: f.queueOp }[name];
}

// --- stratified greedy selection
const QUOTAS = [
  ["subagent", (f) => f.isSubagent, 4],
  ["compaction", (f) => f.compaction, 3],
  ["api_error", (f) => f.apiError, 2],
  ["pr_link", (f) => f.prLink, 2],
  ["queue_op", (f) => f.queueOp, 2],
  ["sidechain", (f) => f.sidechain, 2],
  ["interrupt", (f) => f.interrupt, 2],
  ["malformed", (f) => f.malformed, 1],
  ["small", (f) => f.lines <= 60, 8],
  // over-provisioned: large files are the likeliest to exceed the sanitized
  // size cap at write time; extras beyond TARGET are never written
  ["large", (f) => f.lines > 600 && f.bytes < 1024 * 1024, 10],
];
const picked = new Set();
const tagsOf = new Map();
function tag(f, t) {
  if (!tagsOf.has(f.file)) tagsOf.set(f.file, new Set());
  tagsOf.get(f.file).add(t);
}
for (const [name, pred, quota] of QUOTAS) {
  let have = [...picked].filter((f) => pred(f)).length;
  for (const f of pool) {
    if (have >= quota) break;
    if (pred(f)) {
      if (!picked.has(f)) picked.add(f);
      tag(f, name);
      have = [...picked].filter((x) => pred(x)).length;
    }
  }
}
// version spread: ensure ≥6 distinct versions incl. oldest + newest in pool
const byVersion = new Map();
for (const f of pool) for (const v of f.versions) if (!byVersion.has(v)) byVersion.set(v, f);
const versionsSorted = [...byVersion.keys()].sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true }),
);
const wantVersions = new Set([
  versionsSorted[0],
  versionsSorted[versionsSorted.length - 1],
  ...versionsSorted.filter((_, i) => i % Math.ceil(versionsSorted.length / 6) === 0),
]);
for (const v of wantVersions) {
  const covered = [...picked].some((f) => f.versions.has(v));
  if (!covered && byVersion.get(v)) {
    picked.add(byVersion.get(v));
    tag(byVersion.get(v), `version:${v}`);
  }
}
// --- sanitize + write: quota picks first, then pool backfill, until TARGET
// files actually land on disk (size-skips are replaced, not lost).
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
const manifest = [];
let idx = 0;
const queue = [...picked, ...pool.filter((f) => !picked.has(f))];
for (const f of queue) {
  if (idx >= TARGET) break;
  const outLines = [];
  for (const rec of f.parsed) {
    if (rec && typeof rec === "object" && "__malformed__" in rec) {
      outLines.push(`{"§malformed-line§":${"x".repeat(Math.min(rec.__malformed__, 40))}`);
      continue;
    }
    outLines.push(JSON.stringify(sanitizeValue(rec)));
  }
  const body = outLines.join("\n") + "\n";
  // rare-stratum sessions (compaction/api-error/…) are inherently long —
  // grant them headroom rather than losing the stratum
  const rareTags = ["compaction", "api_error", "pr_link", "queue_op"];
  const isRare = [...(tagsOf.get(f.file) ?? [])].some((t) => rareTags.includes(t));
  const cap = isRare ? 5 * MAX_SANITIZED_BYTES : MAX_SANITIZED_BYTES;
  if (Buffer.byteLength(body) > cap) {
    console.log(`skip (too large sanitized): ${relative(ROOT, f.file)}`);
    continue;
  }
  idx += 1;
  if (!picked.has(f)) tag(f, "fill");
  const sizeTag = f.lines <= 60 ? "small" : f.lines > 600 ? "large" : "medium";
  const name = `s${String(idx).padStart(2, "0")}-${sizeTag}-${token(f.file, 8)}.jsonl`;
  writeFileSync(join(OUT_DIR, name), body);
  manifest.push({
    name,
    lines: f.lines,
    bytes: Buffer.byteLength(body),
    versions: [...f.versions].sort(),
    subagent: f.isSubagent,
    strata: [...(tagsOf.get(f.file) ?? [])].sort(),
    features: {
      compaction: f.compaction,
      apiError: f.apiError,
      prLink: f.prLink,
      queueOp: f.queueOp,
      sidechain: f.sidechain,
      interrupt: f.interrupt,
      malformed: f.malformed,
    },
  });
}

// --- the synthetic future-version fixture (hand-authored, committed via this script for reproducibility)
const FUTURE = [
  `{"type":"hologram-checkpoint","version":"9.9.9","sessionId":"99999999-9999-4999-8999-999999999999","shardId":42}`,
  `{"parentUuid":null,"isSidechain":false,"userType":"external","cwd":"/sanitized/p000000","sessionId":"99999999-9999-4999-8999-999999999999","version":"9.9.9","gitBranch":"branch-000000","type":"user","message":{"role":"user","content":"xxxxxxxxxxxxxxxx"},"uuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2031-01-01T00:00:00.000Z","quantumFlag":true}`,
  `{"parentUuid":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","isSidechain":false,"userType":"external","cwd":"/sanitized/p000000","sessionId":"99999999-9999-4999-8999-999999999999","version":"9.9.9","type":"assistant","message":{"model":"claude-fable-7","role":"assistant","content":[{"type":"neural_shard","payload":"xxxxxxxx"},{"type":"text","text":"xxxxxxxxxxxx"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"holo_tokens":3}},"uuid":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","timestamp":"2031-01-01T00:00:05.000Z"}`,
  `{"type":"quantum-sync","state":{"entangled":true,"peers":3},"sessionId":"99999999-9999-4999-8999-999999999999","version":"9.9.9"}`,
  `{"type":"assistant","sessionId":"99999999-9999-4999-8999-999999999999","version":"9.9.9","message":{"model":"claude-fable-7","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Future","name":"TeleportFile","input":{"file_path":"/sanitized/p000000/f000000.ts"}}],"usage":{"input_tokens":4,"output_tokens":2,"cache_read_input_tokens":9,"cache_creation_input_tokens":1}},"uuid":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","timestamp":"2031-01-01T00:00:09.000Z"}`,
  `{"type":"user","sessionId":"99999999-9999-4999-8999-999999999999","version":"9.9.9","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01Future","content":"xxxxxx","is_error":false}]},"toolUseResult":{"teleported":true},"uuid":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","timestamp":"2031-01-01T00:00:11.000Z"}`,
  // deliberately truncated final line (live-session write race)
  `{"type":"assistant","sessionId":"99999999-9999-4999-8999-999999999999","version":"9.9.9","message":{"model":"claude-fable-7","role":"assis`,
];
writeFileSync(join(OUT_DIR, "synthetic-future-version.jsonl"), FUTURE.join("\n"));
manifest.push({
  name: "synthetic-future-version.jsonl",
  lines: FUTURE.length,
  bytes: Buffer.byteLength(FUTURE.join("\n")),
  versions: ["9.9.9"],
  subagent: false,
  strata: ["synthetic_future"],
  features: { malformed: true },
});

writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      sanitizerVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceRoot: "~/.claude/projects (founder machine)",
      totalFiles: manifest.length,
      files: manifest.sort((a, b) => a.name.localeCompare(b.name)),
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${manifest.length} fixtures to ${OUT_DIR}`);
