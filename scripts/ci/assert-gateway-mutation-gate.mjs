#!/usr/bin/env node

/**
 * Build gate for the gateway mutation nightly.
 *
 * The gateway runs as multiple Stryker shards (see stryker-nightly.yml). Each
 * shard only enforces a low STATIC catastrophe floor (apps/gateway:shard-floor)
 * during its own `stryker run`, so a climbing aggregate floor can never break
 * an intentionally-weaker shard. This script enforces the REAL quality bar on
 * the combined result produced by combine-gateway-scores.mjs:
 *
 *   1. combinedScore (mutant-weighted aggregate) >= apps/gateway floor
 *   2. minShardScore (weakest shard)             >= apps/gateway:shard-floor
 *
 * (2) is the catastrophe tripwire: it catches a single shard collapsing inside
 * an otherwise-healthy weighted average — the failure mode a pure aggregate
 * gate would mask (e.g. a deleted test file taking one shard to 0% while the
 * weighted average barely moves).
 *
 * Usage:
 *   node scripts/ci/assert-gateway-mutation-gate.mjs <score-gateway.json>
 *
 * Exit codes: 0 = pass, 1 = floor violation, 2 = bad input.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const [, , scoreFile] = process.argv;

if (!scoreFile) {
  console.error('Usage: assert-gateway-mutation-gate.mjs <score-gateway.json>');
  process.exit(2);
}
if (!existsSync(scoreFile)) {
  console.error(`Combined score file not found: ${scoreFile}`);
  process.exit(2);
}

const floorsPath = path.join(process.cwd(), 'scripts/ci/mutation-score-floors.json');
const floors = JSON.parse(readFileSync(floorsPath, 'utf8'));
const aggregateFloor = floors['apps/gateway'];
const shardFloor = floors['apps/gateway:shard-floor'] ?? 0;

const score = JSON.parse(readFileSync(scoreFile, 'utf8'));
// combine-gateway-scores.mjs sets `score` to the aggregate, but read the
// explicit fields so the gate is robust to that primary-field choice.
const combined =
  typeof score.combinedScore === 'number' ? score.combinedScore : score.score;
const minShard =
  typeof score.minShardScore === 'number' ? score.minShardScore : combined;

if (typeof combined !== 'number') {
  console.error(`Score file ${scoreFile} has no numeric combinedScore/score`);
  process.exit(2);
}

const failures = [];
if (typeof aggregateFloor === 'number' && combined < aggregateFloor) {
  failures.push(
    `aggregate ${combined.toFixed(2)}% < floor ${aggregateFloor}% (apps/gateway)`,
  );
}
if (typeof shardFloor === 'number' && minShard < shardFloor) {
  failures.push(
    `weakest shard ${minShard.toFixed(2)}% < catastrophe floor ${shardFloor}% (apps/gateway:shard-floor)`,
  );
}

if (failures.length > 0) {
  console.error('❌ Gateway mutation gate FAILED:');
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}

console.log(
  `✓ Gateway mutation gate passed: aggregate ${combined.toFixed(2)}% >= ${aggregateFloor}%, ` +
    `weakest shard ${minShard.toFixed(2)}% >= ${shardFloor}%`,
);
