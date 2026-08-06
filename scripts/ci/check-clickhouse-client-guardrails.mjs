#!/usr/bin/env node
/**
 * ClickHouse client guardrail check.
 *
 * Every ClickHouse client construction site is a place where an unbounded
 * query can reach a shared instance and pin its SERVER-wide memory ceiling —
 * when that happens, every co-tenant workload's queries die as collateral
 * (observed on staging: a single unbounded query shape produced 42k+
 * memory-limit kills in 13 hours and starved the enrichment pipeline to
 * single-digit throughput).
 *
 * This check enforces the containment rule: `createClient` from
 * `@clickhouse/client*` may appear ONLY in the allowlisted factory/service
 * modules below. New call sites must either use an existing guarded factory
 * (see apps/gateway/src/billing/metering-clickhouse.ts or
 * ENRICHMENT_QUERY_SETTINGS in apps/gateway/src/stores/clickhouse/topics-store.ts)
 * or be added here deliberately, in a reviewed diff, with per-query memory
 * caps + spill settings of their own.
 *
 * The list may shrink as legacy sites adopt guarded factories; additions
 * need the caps story told in the PR.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

const SCAN_ROOTS = [
  "apps/gateway/src",
  "apps/tenant-dashboard/src",
  "packages/gateway-core/src",
  "packages/observability-service/src",
  "packages/trace-topics/src",
];

const ALLOWLIST = new Set([
  // Guarded factories (memory caps + spill baked in).
  "apps/gateway/src/billing/metering-clickhouse.ts",
  "apps/gateway/src/stores/clickhouse/topics-store.ts",
  // Legacy constructor sites, grandfathered: migrate to a guarded factory
  // (or grow caps of their own) before adding anything new here.
  "apps/tenant-dashboard/src/lib/analytics/client.ts",
  "packages/gateway-core/src/openapi/analytics-factory.ts",
  "packages/gateway-core/src/openapi/routes/agents.ts",
  "packages/gateway-core/src/openapi/routes/scores.ts",
  "packages/gateway-core/src/openapi/routes/spans.ts",
  "packages/gateway-core/src/services/clickhouse-service.ts",
  "packages/gateway-core/src/services/health.ts",
  "packages/gateway-core/src/stores/clickhouse/retention-store.ts",
  "packages/gateway-core/src/stores/clickhouse/store.ts",
  "packages/observability-service/src/client.ts",
]);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, files);
    } else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

const violations = [];
const seenAllowlisted = new Set();

for (const scanRoot of SCAN_ROOTS) {
  const abs = join(ROOT, scanRoot);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const source = readFileSync(file, "utf8");
    const importsClickHouse = /from\s+["']@clickhouse\/client(-web)?["']/.test(source);
    const constructsClient = /\bcreateClient\s*\(/.test(source);
    if (!importsClickHouse || !constructsClient) continue;

    const rel = relative(ROOT, file);
    if (ALLOWLIST.has(rel)) {
      seenAllowlisted.add(rel);
    } else {
      violations.push(rel);
    }
  }
}

const stale = [...ALLOWLIST].filter(
  (entry) => !seenAllowlisted.has(entry) && !existsSync(join(ROOT, entry)),
);

let failed = false;
if (violations.length > 0) {
  failed = true;
  console.error(
    "✗ ClickHouse clients constructed outside the guarded allowlist:\n" +
      violations.map((v) => `  - ${v}`).join("\n") +
      "\n\nUse a guarded factory (per-query memory caps + spill — see" +
      " apps/gateway/src/billing/metering-clickhouse.ts), or add the file to" +
      " scripts/ci/check-clickhouse-client-guardrails.mjs with its own caps" +
      " and say so in the PR. Unbounded clients on shared instances take" +
      " down every co-tenant workload when one query goes wide.",
  );
}
if (stale.length > 0) {
  failed = true;
  console.error(
    "✗ Stale allowlist entries (file deleted or renamed — remove them):\n" +
      stale.map((v) => `  - ${v}`).join("\n"),
  );
}

if (failed) process.exit(1);
console.log(
  `✓ clickhouse-client-guardrails: ${seenAllowlisted.size} sanctioned constructor site(s), no strays`,
);
