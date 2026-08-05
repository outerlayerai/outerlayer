#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Hook fast-path latency benchmark (<50ms p95). Measures the
// REAL cost a hook pays: cold `node dist/index.js hook <event>` process spawn
// (parse arg, read stdin, append spool, exit) — that end-to-end spawn IS the
// budget, since Claude Code spawns a fresh process per hook.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "dist", "index.js");
const N = Number(process.argv[2] ?? 60);
const payload = JSON.stringify({
  session_id: "bench-0000",
  transcript_path: "/tmp/x/.claude/projects/-p/bench.jsonl",
  cwd: "/tmp/x/proj",
  hook_event_name: "SessionEnd",
});

const home = mkdtempSync(join(tmpdir(), "ol-bench-"));
const samples = [];
try {
  // one warmup to page in the file cache
  execFileSync("node", [BIN, "hook", "SessionEnd"], { input: payload, env: { ...process.env, HOME: home } });
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    execFileSync("node", [BIN, "hook", "SessionEnd"], { input: payload, env: { ...process.env, HOME: home } });
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

samples.sort((a, b) => a - b);
const pct = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))];
const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
console.log(`hook fast-path over ${N} cold spawns:`);
console.log(`  mean ${mean.toFixed(1)}ms | p50 ${pct(50).toFixed(1)}ms | p95 ${pct(95).toFixed(1)}ms | p99 ${pct(99).toFixed(1)}ms | max ${samples.at(-1).toFixed(1)}ms`);
const budget = 50;
const p95 = pct(95);
console.log(p95 < budget ? `  ✓ p95 within ${budget}ms budget` : `  ✗ p95 EXCEEDS ${budget}ms budget`);
process.exit(p95 < budget ? 0 : 1);
