#!/usr/bin/env node

/**
 * Combines per-shard Stryker score files (score-gateway-*.json) into a
 * single combined score-gateway.json that the ratchet + weekly-summary
 * scripts can consume as if gateway ran as one workspace.
 *
 * Why this exists:
 *   gateway has ~3,440 mutants and the full nightly run takes ~3.5 h,
 *   well past the 2 h GitHub Actions job timeout. We shard the run
 *   across parallel matrix jobs (gateway-services, gateway-routes-big,
 *   gateway-routes-rest, gateway-lib-utils) — each fits in <15 min —
 *   then aggregate the per-shard score files here so downstream
 *   workflow steps continue to see "gateway" as a single workspace
 *   with one score, one floor entry, and one row in the weekly report.
 *
 * Score formula matches scripts/ci/extract-mutation-score.mjs exactly
 * (Stryker's mutationScore: NoCoverage counts against the score).
 *
 * Usage:
 *   node scripts/ci/combine-gateway-scores.mjs <input-dir> <output-file>
 *
 *   input-dir   directory containing score-gateway-*.json shard files
 *   output-file path to write the combined score-gateway.json
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const [, , inputDir, outputFile] = process.argv;

if (!inputDir || !outputFile) {
  console.error('Usage: combine-gateway-scores.mjs <input-dir> <output-file>');
  process.exit(1);
}

if (!existsSync(inputDir)) {
  console.error(`Input directory not found: ${inputDir}`);
  process.exit(1);
}

const shardFiles = readdirSync(inputDir).filter(
  (f) => /^score-gateway-[a-z-]+\.json$/.test(f),
);

if (shardFiles.length === 0) {
  console.error(`No gateway shard score files found in ${inputDir}`);
  console.error(
    'Expected files matching: score-gateway-services.json, score-gateway-routes-big.json, etc.',
  );
  process.exit(1);
}

let killed = 0;
let survived = 0;
let timeout = 0;
let noCoverage = 0;
const shards = [];

for (const file of shardFiles.sort()) {
  const parsed = JSON.parse(readFileSync(path.join(inputDir, file), 'utf8'));
  killed += parsed.killed ?? 0;
  survived += parsed.survived ?? 0;
  timeout += parsed.timeout ?? 0;
  noCoverage += parsed.noCoverage ?? 0;
  shards.push({
    name: parsed.workspace,
    score: parsed.score,
    killed: parsed.killed,
    survived: parsed.survived,
    timeout: parsed.timeout,
    noCoverage: parsed.noCoverage,
  });
}

const total = killed + survived + timeout + noCoverage;
const detected = killed + timeout;
const combinedScore = total === 0 ? 0 : Number(((detected / total) * 100).toFixed(2));
const covered = killed + survived + timeout;
const combinedCoveredScore = covered === 0 ? 0 : Number(((detected / covered) * 100).toFixed(2));

// The headline gateway score is the mutant-weighted aggregate
// (`combinedScore` = detected/total across all shards), NOT the MIN
// shard. The aggregate is the number that actually reflects "what
// fraction of gateway mutants do our tests catch", so it's what the
// ratchet floor (apps/gateway) tracks and what the build gates on (see
// assert-gateway-mutation-gate.mjs).
//
// Per-shard `stryker run` no longer enforces the ratcheted floor — it
// enforces a low static catastrophe floor (apps/gateway:shard-floor)
// instead, so a climbing aggregate floor can't break an
// intentionally-weaker shard (the failure mode this guards against: a
// combined score of 70.56% while gateway-utils sat at 50%, below the
// ratchet's bumped floor of 69).
//
// `minShardScore` is retained as the catastrophe tripwire: the gate
// also fails if any single shard drops below the shard-floor, so an
// isolated collapse (e.g. a deleted test file taking one shard to 0%)
// can't hide inside a healthy weighted average.
const shardScores = shards
  .map((s) => s.score)
  .filter((s) => typeof s === 'number');
const minShardScore = shardScores.length === 0
  ? 0
  : Number(Math.min(...shardScores).toFixed(2));

const result = {
  workspace: 'gateway',
  // Primary score = mutant-weighted aggregate (see above). Drives the
  // ratcheted apps/gateway floor + the aggregate build gate.
  score: combinedScore,
  combinedScore,
  combinedCoveredScore,
  // Weakest shard — the catastrophe tripwire (apps/gateway:shard-floor).
  minShardScore,
  killed,
  survived,
  timeout,
  noCoverage,
  total,
  timestamp: new Date().toISOString(),
  shards, // for debugging — ratchet/summary scripts don't use this field
};

writeFileSync(outputFile, JSON.stringify(result) + '\n');

console.log(JSON.stringify(result, null, 2));
console.log('');
console.log(`Combined ${shardFiles.length} shards: ${shardFiles.join(', ')}`);
console.log(`Gateway score: ${combinedScore}% (mutant-weighted aggregate; weakest shard: ${minShardScore}%)`);
console.log(`Counts: ${killed} killed, ${survived} survived, ${noCoverage} no-cov, ${timeout} timeout`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `## Gateway · combined shard score`,
    '',
    `**Score (weighted aggregate): ${combinedScore}%**  ·  Weakest shard: ${minShardScore}%`,
    '_The aggregate drives the ratchet floor + build gate; the weakest shard is the catastrophe tripwire._',
    '',
    '| Shard | Score | Killed | Survived | No coverage |',
    '|-------|------:|-------:|---------:|------------:|',
    ...shards.map(
      (s) => `| ${s.name} | ${s.score?.toFixed(2)}% | ${s.killed} | ${s.survived} | ${s.noCoverage} |`,
    ),
    '',
    '| **Total** | **' + combinedScore + '%** | **' + killed + '** | **' + survived + '** | **' + noCoverage + '** |',
    '',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
