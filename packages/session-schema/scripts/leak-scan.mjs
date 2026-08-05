#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.
//
// Leak scanner: every string leaf in every fixture must be a
// keep-shaped value, a sanitizer grammar token, or a harness constant. Also
// scans raw bytes for founder-identifying needles. Exit 1 on any finding.
//
//   node scripts/leak-scan.mjs [dir=fixtures/raw]

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanValue, FORBIDDEN_NEEDLES } from "./sanitize-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.argv[2] ?? join(HERE, "..", "fixtures", "raw");

export function scanFixtureFile(file) {
  const violations = [];
  const bytes = readFileSync(file, "utf8");
  const needle = FORBIDDEN_NEEDLES.exec(bytes);
  if (needle) violations.push({ path: "(raw bytes)", sample: needle[0] });
  const lines = bytes.split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      // malformed lines are legitimate fixtures IF they are the malformed-line
      // token or an x-filled truncation of a sanitized line.
      if (/^\{"§malformed-line§":x*$/.test(trimmed)) return;
      if (i === lines.length - 1 || (i === lines.length - 2 && lines[lines.length - 1] === "")) {
        // truncated final line: must not contain un-sanitized free text —
        // approximate by rejecting whitespace-containing word runs
        if (!/[A-Za-z]{2,} [A-Za-z]{2,} [A-Za-z]{2,}/.test(trimmed)) return;
      }
      violations.push({ path: `line ${i + 1} (unparseable)`, sample: trimmed.slice(0, 80) });
      return;
    }
    for (const v of scanValue(rec)) {
      violations.push({ path: `line ${i + 1} ${v.path}`, sample: v.sample });
    }
  });
  return violations;
}

export function scanDir(dir) {
  const findings = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    for (const v of scanFixtureFile(join(dir, name))) {
      findings.push({ file: name, ...v });
    }
  }
  return findings;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const findings = scanDir(DIR);
  if (findings.length > 0) {
    console.error(`LEAK SCAN FAILED — ${findings.length} finding(s):`);
    for (const f of findings.slice(0, 50)) {
      console.error(`  ${f.file} ${f.path}: ${JSON.stringify(f.sample)}`);
    }
    process.exit(1);
  }
  console.log(`leak scan clean (${DIR})`);
}
